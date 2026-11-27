/**
 * THE SCENE NOTE WRITER (Phase 5.1). A scene's note is the author's own
 * plain-text note beside the prose; a research finding the author accepts is
 * appended to it (D3: a note, never prose). Every change writes one
 * `SceneNoteVersion` in the same transaction, numbered under the scene's lock:
 * MANUAL for the author's own edit, RESEARCH naming the proposal and the
 * findings it is drawn from (rule 1; the CHECK `SceneNoteVersion_shape`).
 *
 * This module writes the NOTE and nothing else: it never imports the scene
 * text writer (`manuscript-text.ts`), so a research acceptance cannot reach
 * a scene's text (`tests/guards/scene-text-stays-off-the-model-path.test.ts`).
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { ManuscriptRepository, ManuscriptSceneRepository, SceneNoteVersionRepository } from '@/app-layer/repositories/manuscript.repository';
import type { PrismaTx } from '@/lib/db/rls-middleware';
import { ConflictError, NotFoundError } from '@/lib/errors/types';
import { sanitiseSceneNote, ManuscriptTextTooLongError } from '@/lib/manuscript/storage';
import { tooLong } from './manuscript-common';

export type NoteSource = { source: 'MANUAL' } | { source: 'RESEARCH'; proposalId: string; findingIds: readonly string[] };

export interface NoteWriteResult {
    noteVersion: number;
    /** The SceneNoteVersion written, or null when nothing changed. */
    versionId: string | null;
}

/** Write the scene's note (the caller holds the scene's lock and checked the base it names, if any). */
export async function writeSceneNoteInTx(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, sceneId: string, raw: string, meta: NoteSource): Promise<NoteWriteResult> {
    const scene = await ManuscriptSceneRepository.find(db, ctx.workspaceId, bookId, sceneId);
    if (!scene) throw new NotFoundError('Scene not found.');
    let note: string;
    try {
        note = sanitiseSceneNote(raw);
    } catch (err) {
        tooLong(err);
    }
    if (note === (scene.note ?? '')) return { noteVersion: scene.noteVersion, versionId: null };
    const versionNumber = scene.noteVersion + 1;
    await ManuscriptSceneRepository.setNote(db, ctx.workspaceId, sceneId, { note: note === '' ? null : note, noteVersion: versionNumber });
    const version = await SceneNoteVersionRepository.create(db, ctx.workspaceId, {
        bookId,
        sceneId,
        versionNumber,
        note,
        source: meta.source,
        sourceFindingIds: meta.source === 'RESEARCH' ? meta.findingIds : [],
        sourceResearchProposalId: meta.source === 'RESEARCH' ? meta.proposalId : null,
        authorId: ctx.userId,
    });
    return { noteVersion: versionNumber, versionId: version.id };
}

/**
 * Append an accepted research note to the scene's note, as a paragraph of its
 * own (RESEARCH, naming the proposal and its findings). Takes the scene's lock.
 * A scene gone since the proposal is 409 PROPOSAL_STALE; a note that would pass
 * its bound is 409 NOTE_FULL (the author trims the note, then accepts).
 */
export async function appendResearchNoteInTx(
    db: PrismaTx,
    ctx: WorkspaceRequestContext,
    bookId: string,
    sceneId: string,
    text: string,
    from: { proposalId: string; findingIds: readonly string[] },
): Promise<NoteWriteResult> {
    await ManuscriptRepository.lockScene(db, sceneId);
    const scene = await ManuscriptSceneRepository.find(db, ctx.workspaceId, bookId, sceneId);
    if (!scene) throw new ConflictError('The scene this note is for was deleted.', { reason: 'PROPOSAL_STALE' });
    const next = scene.note ? `${scene.note}\n\n${text}` : text;
    try {
        sanitiseSceneNote(next);
    } catch (err) {
        if (err instanceof ManuscriptTextTooLongError) throw new ConflictError('The scene note is full; shorten it first.', { reason: 'NOTE_FULL' });
        throw err;
    }
    return writeSceneNoteInTx(db, ctx, bookId, sceneId, next, { source: 'RESEARCH', ...from });
}
