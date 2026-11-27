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
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { BibleElementRepository, BibleRelationRepository } from '@/app-layer/repositories/bible.repository';
import { SELECTION_RELATIONS_MAX } from '@/app-layer/schemas/interview';
import type { PrismaTx } from '@/lib/db/rls-middleware';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors/types';
import { SceneCardRepository } from '@/app-layer/repositories/scene-card.repository';
import { sceneCarrierOf } from '@/lib/manuscript/scene-card';
import type { BibleKind } from '@/lib/bible/kinds';

/**
 * SCENE (Phase 5.3, "Grill me on this scene"): one manuscript scene of the book (404 otherwise: another book's or
 * workspace's scene reads as missing) whose CARD the session asks about. Its questions are filed under its carrier
 * element (`sceneCarrierOf`), so a scene that names no element at all — no point of view, setting, beat or link — is
 * 409 SCENE_HAS_NO_ELEMENT: link one first. Its prose is never a target (D3).
 */
export async function resolveSceneScope(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, sceneId: string): Promise<{ sceneId: string; carrierElementId: string }> {
    const scene = await SceneCardRepository.sceneForInterview(db, ctx.workspaceId, bookId, sceneId);
    if (!scene) throw new NotFoundError('Scene not found.');
    const carrierId = sceneCarrierOf(scene);
    const carrier = carrierId ? await BibleElementRepository.find(db, ctx.workspaceId, bookId, carrierId) : null;
    if (!carrier) throw new ConflictError('Link this scene to a character, a setting or a beat first.', { reason: 'SCENE_HAS_NO_ELEMENT' });
    return { sceneId: scene.id, carrierElementId: carrier.id };
}

// BETWEEN slots live in `story-slot.ts`, which the bible's write path may import (this module reaches the dials).
export { resolveBetweenSlot, SLOT_KIND, type BetweenSlot } from './story-slot';

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

