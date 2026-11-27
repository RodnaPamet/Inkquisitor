/**
 * THE SCENE CARD WRITER (Phase 5.3): the ONE module that writes a scene's card (goal, conflict, outcome, what changed)
 * or a version of it. Never the scene's prose (D3): nothing here imports the scene text writer or a text-writing
 * repository method, and nothing here reaches a model (`tests/guards/scene-text-stays-off-the-model-path.test.ts`).
 *
 *   read      `getSceneCard` (`bible.view`): the card (empty for a scene never carded) and its latest versions.
 *   save      `saveSceneCard` (`bible.edit`): the author's edit of the whole card, naming the version it was made from
 *             (409 VERSION_CONFLICT with `currentVersion`, nothing written); every field sanitised
 *             (`sanitiseSceneCardField`); a save that changes nothing writes nothing; otherwise one card version
 *             (MANUAL).
 *   accept    `acceptSceneCardFieldInTx`: an accepted SCENE_CARD_FIELD proposal of "Grill me on this scene" (rule 1:
 *             only the author's acceptance, in `enrichment-review.ts`), one field set or cleared, one version
 *             (INTERVIEW) naming the answers it is drawn from (CHECK `SceneCardVersion_shape`).
 *
 * LOCK ORDER: the scene's lock (`manuscript-scene:<sceneId>`, as every scene write takes it) then the card row; audit
 * last.
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { logEvent } from '@/app-layer/events/audit';
import { assertPermission } from '@/app-layer/policies/permission.policy';
import { ManuscriptRepository } from '@/app-layer/repositories/manuscript.repository';
import { SceneCardRepository, SceneCardVersionRepository, type SceneCardRow } from '@/app-layer/repositories/scene-card.repository';
import { SceneCardInput } from '@/app-layer/schemas/draft';
import { runInWorkspaceContext, type PrismaTx } from '@/lib/db/rls-middleware';
import { ConflictError, ValidationError } from '@/lib/errors/types';
import { SCENE_CARD_FIELD_KEYS, SCENE_CARD_VERSIONS_LISTED, type SceneCardFieldKey, type SceneCardValues, type SceneCardView } from '@/lib/manuscript/scene-card';
import { ManuscriptTextTooLongError, sanitiseSceneCardField, serialiseSceneCardSnapshot } from '@/lib/manuscript/storage';
import { requireBook } from './bible-common';
import { requireScene } from './manuscript-common';

function valuesOf(card: SceneCardRow | null): SceneCardValues {
    return { goal: card?.goal ?? null, conflict: card?.conflict ?? null, outcome: card?.outcome ?? null, change: card?.change ?? null };
}

async function viewOf(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, sceneId: string, card: SceneCardRow | null): Promise<SceneCardView> {
    const versions = await SceneCardVersionRepository.listVersions(db, ctx.workspaceId, bookId, sceneId, SCENE_CARD_VERSIONS_LISTED);
    return { sceneId, ...valuesOf(card), version: card?.version ?? 0, versions: versions.map((v) => ({ versionNumber: v.versionNumber, source: v.source as 'MANUAL' | 'INTERVIEW', createdAt: v.createdAt.toISOString() })) };
}

export async function getSceneCard(ctx: WorkspaceRequestContext, bookId: string, sceneId: string): Promise<SceneCardView> {
    await assertPermission(ctx, 'bible.view');
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        await requireScene(db, ctx, bookId, sceneId);
        return viewOf(db, ctx, bookId, sceneId, await SceneCardRepository.find(db, ctx.workspaceId, bookId, sceneId));
    });
}

function sanitised(input: Record<SceneCardFieldKey, string | null>): SceneCardValues {
    try {
        return { goal: sanitiseSceneCardField(input.goal), conflict: sanitiseSceneCardField(input.conflict), outcome: sanitiseSceneCardField(input.outcome), change: sanitiseSceneCardField(input.change) };
    } catch (err) {
        if (err instanceof ManuscriptTextTooLongError) throw new ValidationError('A card field is too long.', { reason: 'TOO_LONG', field: 'card' });
        throw err;
    }
}

/** Write the card's next state and its version (the caller holds the scene's lock). Null when nothing changed. */
async function writeCardInTx(
    db: PrismaTx,
    ctx: WorkspaceRequestContext,
    bookId: string,
    sceneId: string,
    current: SceneCardRow | null,
    next: SceneCardValues,
    source: { kind: 'MANUAL' } | { kind: 'INTERVIEW'; answerIds: readonly string[] },
): Promise<{ versionId: string; versionNumber: number } | null> {
    const before = valuesOf(current);
    if (SCENE_CARD_FIELD_KEYS.every((k) => before[k] === next[k])) return null;
    const versionNumber = (current?.version ?? 0) + 1;
    await SceneCardRepository.upsert(db, ctx.workspaceId, bookId, sceneId, { ...next, version: versionNumber });
    const v = await SceneCardVersionRepository.createVersion(db, ctx.workspaceId, {
        bookId,
        sceneId,
        versionNumber,
        snapshot: serialiseSceneCardSnapshot(next),
        source: source.kind,
        sourceAnswerIds: source.kind === 'INTERVIEW' ? source.answerIds : [],
        authorId: ctx.userId,
    });
    return { versionId: v.id, versionNumber };
}

/** The author's edit of the whole card (the header's save). */
export async function saveSceneCard(ctx: WorkspaceRequestContext, bookId: string, sceneId: string, input: unknown): Promise<SceneCardView> {
    await assertPermission(ctx, 'bible.edit');
    const parsed = SceneCardInput.parse(input);
    const next = sanitised(parsed);
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        await ManuscriptRepository.lockScene(db, sceneId);
        await requireScene(db, ctx, bookId, sceneId);
        const current = await SceneCardRepository.find(db, ctx.workspaceId, bookId, sceneId);
        const currentVersion = current?.version ?? 0;
        if (currentVersion !== parsed.baseVersion) throw new ConflictError('This card was saved elsewhere since your edit began.', { reason: 'VERSION_CONFLICT', currentVersion, baseVersion: parsed.baseVersion });
        const written = await writeCardInTx(db, ctx, bookId, sceneId, current, next, { kind: 'MANUAL' });
        if (written) {
            // AUDIT LAST (3.H).
            await logEvent(ctx, { action: 'SCENE_CARD_SAVED', entityType: 'ManuscriptScene', entityId: sceneId, details: { bookId, versionNumber: written.versionNumber, source: 'MANUAL' } }, { db });
        }
        return viewOf(db, ctx, bookId, sceneId, await SceneCardRepository.find(db, ctx.workspaceId, bookId, sceneId));
    });
}

/**
 * One card field from an accepted SCENE_CARD_FIELD proposal (the header's accept), in the caller's transaction, after
 * the caller asked `bible.edit` and checked the proposal is PENDING. Under the scene's lock:
 *
 *   reviewedBase     the card version the author's review read: another is 409 VERSION_CONFLICT (`currentVersion`);
 *   proposedAgainst  the version the proposal was made against: a card moved since needs `reviewedCurrent`, else 409
 *                    PROPOSAL_OUTDATED;
 *   operation        must still fit the field (ADD empty, UPDATE / REMOVE filled), else 409 PROPOSAL_STALE;
 *   editedValue      the author's own wording of the value (never on a REMOVE, never empty: 400 EDIT_NOT_ALLOWED).
 *
 * A write that changes nothing is 400 EDIT_CHANGES_NOTHING. It writes one version (INTERVIEW, naming the answers) and
 * NO audit row: the caller decides the proposal and audits last.
 */
export async function acceptSceneCardFieldInTx(
    db: PrismaTx,
    ctx: WorkspaceRequestContext,
    bookId: string,
    sceneId: string,
    change: {
        fieldKey: SceneCardFieldKey;
        operation: 'ADD' | 'UPDATE' | 'REMOVE';
        proposedValue: string | null;
        editedValue?: string;
        proposedAgainst: number;
        reviewedBase: number;
        reviewedCurrent: boolean;
        answerIds: readonly string[];
    },
): Promise<{ versionId: string; versionNumber: number; edited: boolean }> {
    await ManuscriptRepository.lockScene(db, sceneId);
    await requireScene(db, ctx, bookId, sceneId);
    const current = await SceneCardRepository.find(db, ctx.workspaceId, bookId, sceneId);
    const currentVersion = current?.version ?? 0;
    if (currentVersion !== change.reviewedBase) throw new ConflictError('This card was saved elsewhere since you read it.', { reason: 'VERSION_CONFLICT', currentVersion });
    if (change.proposedAgainst !== change.reviewedBase && !change.reviewedCurrent) {
        throw new ConflictError('This card changed since the proposal was made; review its current value first.', { reason: 'PROPOSAL_OUTDATED', currentVersion, proposedAgainst: change.proposedAgainst });
    }
    const values = valuesOf(current);
    const held = values[change.fieldKey];
    const fits = change.operation === 'ADD' ? held === null : held !== null;
    if (!fits) throw new ConflictError('The field no longer holds what this proposal was made for.', { reason: 'PROPOSAL_STALE', operation: change.operation });
    let value: string | null = change.operation === 'REMOVE' ? null : change.proposedValue;
    let edited = false;
    if (change.editedValue !== undefined) {
        if (change.operation === 'REMOVE') throw new ValidationError('A removal has no value to edit.', { reason: 'EDIT_NOT_ALLOWED' });
        const next = sanitised({ ...values, [change.fieldKey]: change.editedValue })[change.fieldKey];
        if (next === null) throw new ValidationError('An edit cannot empty the field; reject the proposal instead.', { reason: 'EDIT_NOT_ALLOWED' });
        edited = next !== sanitised({ ...values, [change.fieldKey]: change.proposedValue })[change.fieldKey];
        value = next;
    }
    const next = sanitised({ ...values, [change.fieldKey]: value });
    const written = await writeCardInTx(db, ctx, bookId, sceneId, current, next, { kind: 'INTERVIEW', answerIds: change.answerIds });
    if (!written) throw new ValidationError('That would change nothing.', { reason: 'EDIT_CHANGES_NOTHING' });
    return { ...written, edited };
}
