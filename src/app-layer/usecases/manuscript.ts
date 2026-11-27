/**
 * The manuscript's structure (Phase 5.1, D33): read the outline; create,
 * rename, move and delete parts, chapters and scenes.
 *
 * Every call asks its permission first (`bible.view` reads, `bible.edit`
 * writes; audited on refusal) and runs inside `runInWorkspaceContext`. Every
 * structural write takes the manuscript's STRUCTURE lock first
 * (`ManuscriptRepository.lockStructure`; a scene's own lock after it), so
 * counts and ranks are read and written in turn, and makes the manuscript on
 * its first write (a read never writes).
 *
 * A PART IS STRUCTURALLY REQUIRED, but never asked for: a chapter created with
 * no part named goes into the last part, and into a new untitled part when the
 * manuscript has none. A manuscript of one untitled part shows no part level
 * (`singleDefaultPart`). Deleting a part or chapter that still holds scenes is
 * refused 409 NOT_EMPTY naming how many, unless the request confirms that very
 * count (`confirmScenes`): the author is told what goes, and a scene added
 * meanwhile is never deleted unseen. A scene's history (its versions) stays
 * with the book, as a bible element's does.
 *
 * Creates, deletes and imports are audited (ids and counts only); audit last.
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { logEvent } from '@/app-layer/events/audit';
import { assertPermission } from '@/app-layer/policies/permission.policy';
import {
    ManuscriptChapterRepository,
    ManuscriptPartRepository,
    ManuscriptRepository,
    ManuscriptSceneRepository,
} from '@/app-layer/repositories/manuscript.repository';
import {
    CreateChapterInput,
    CreatePartInput,
    CreateSceneInput,
    ManuscriptIdParam,
    MoveChapterInput,
    MovePartInput,
    MoveSceneInput,
    RenameInput,
} from '@/app-layer/schemas/manuscript';
import { runInWorkspaceContext, type PrismaTx } from '@/lib/db/rls-middleware';
import { ConflictError, NotFoundError } from '@/lib/errors/types';
import { sanitiseManuscriptTitle } from '@/lib/manuscript/storage';
import { sceneRestorableUntil, sceneRestoreCutoff } from '@/lib/manuscript/scene-retention';
import { CHAPTERS_PER_MANUSCRIPT_MAX, DELETED_SCENES_LISTED_MAX, PARTS_PER_MANUSCRIPT_MAX, SCENES_PER_MANUSCRIPT_MAX } from '@/lib/manuscript/vocabulary';
import { requireBook } from './bible-common';
import {
    byRank,
    ensureManuscript,
    outlineView,
    placeAmong,
    rankAmong,
    readOutlineRows,
    recordManuscriptRebalance,
    requireChapter,
    requirePart,
    tooLong,
    type OutlineView,
} from './manuscript-common';

const CHILDREN_READ_MAX = SCENES_PER_MANUSCRIPT_MAX + 1;

function title(raw: string | null | undefined): string | null {
    try {
        return sanitiseManuscriptTitle(raw);
    } catch (err) {
        tooLong(err);
    }
}

function full(what: 'TOO_MANY_PARTS' | 'TOO_MANY_CHAPTERS' | 'TOO_MANY_SCENES'): never {
    throw new ConflictError('The manuscript holds as many as it can.', { reason: what });
}

async function outline(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string): Promise<OutlineView> {
    return outlineView(await readOutlineRows(db, ctx, bookId));
}

/** The book's manuscript outline (`bible.view`): parts → chapters → scenes, no text, words summed. */
export async function getManuscriptOutline(ctx: WorkspaceRequestContext, bookId: string): Promise<OutlineView> {
    await assertPermission(ctx, 'bible.view');
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        return outline(db, ctx, bookId);
    });
}

// ─── Parts ──────────────────────────────────────────────────────────

export async function createPart(ctx: WorkspaceRequestContext, bookId: string, input: unknown): Promise<{ id: string; outline: OutlineView }> {
    await assertPermission(ctx, 'bible.edit');
    const parsed = CreatePartInput.parse(input);
    const name = title(parsed.title);
    return runInWorkspaceContext(ctx, async (db) => {
        await ManuscriptRepository.lockStructure(db, bookId);
        const manuscript = await ensureManuscript(db, ctx, bookId);
        const parts = await ManuscriptPartRepository.list(db, ctx.workspaceId, bookId, PARTS_PER_MANUSCRIPT_MAX + 1);
        if (parts.length >= PARTS_PER_MANUSCRIPT_MAX) full('TOO_MANY_PARTS');
        const place = await placeAmong(db, ctx, 'part', parts, null, parsed);
        const part = await ManuscriptPartRepository.create(db, ctx.workspaceId, { bookId, manuscriptId: manuscript.id, title: name, rank: place.rank });
        await logEvent(ctx, { action: 'MANUSCRIPT_PART_CREATED', entityType: 'ManuscriptPart', entityId: part.id, details: { bookId } }, { db });
        await recordManuscriptRebalance(db, ctx, bookId, 'part', manuscript.id, place.rebalanced);
        return { id: part.id, outline: await outline(db, ctx, bookId) };
    });
}

export async function renamePart(ctx: WorkspaceRequestContext, bookId: string, partId: string, input: unknown): Promise<OutlineView> {
    await assertPermission(ctx, 'bible.edit');
    const id = ManuscriptIdParam.parse(partId);
    const name = title(RenameInput.parse(input).title);
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        await requirePart(db, ctx, bookId, id);
        await ManuscriptPartRepository.rename(db, ctx.workspaceId, id, name);
        return outline(db, ctx, bookId);
    });
}

export async function movePart(ctx: WorkspaceRequestContext, bookId: string, partId: string, input: unknown): Promise<OutlineView> {
    await assertPermission(ctx, 'bible.edit');
    const id = ManuscriptIdParam.parse(partId);
    const parsed = MovePartInput.parse(input);
    return runInWorkspaceContext(ctx, async (db) => {
        await ManuscriptRepository.lockStructure(db, bookId);
        await requireBook(db, ctx, bookId);
        await requirePart(db, ctx, bookId, id);
        const parts = await ManuscriptPartRepository.list(db, ctx.workspaceId, bookId, PARTS_PER_MANUSCRIPT_MAX + 1);
        const place = await placeAmong(db, ctx, 'part', parts, id, parsed);
        await ManuscriptPartRepository.setRank(db, ctx.workspaceId, id, place.rank);
        await recordManuscriptRebalance(db, ctx, bookId, 'part', parts.find((p) => p.id === id)?.manuscriptId ?? bookId, place.rebalanced);
        return outline(db, ctx, bookId);
    });
}

/** How many scenes a part or chapter holds, refusing its deletion unless the request names that very count. */
function assertConfirmed(sceneCount: number, confirmScenes: number | undefined, chapters?: number, recentlyDeleted = 0): void {
    // 5.H-a: a chapter's recently deleted scenes (restorable for 30 days) go FOR GOOD with it, so they are counted in
    // what the author confirms, and named apart.
    const total = sceneCount + recentlyDeleted;
    if (total > 0 && confirmScenes !== total) {
        throw new ConflictError('It still holds scenes.', { reason: 'NOT_EMPTY', scenes: total, recentlyDeleted, ...(chapters !== undefined ? { chapters } : {}) });
    }
}

/** Restorable deleted scenes of these chapters (they go, for good, with a deleted chapter or part). */
async function deletedIn(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, chapterIds: readonly string[]): Promise<number> {
    const by = await ManuscriptSceneRepository.deletedByChapter(db, ctx.workspaceId, bookId);
    return chapterIds.reduce((n, id) => n + (by.get(id) ?? 0), 0);
}

export async function deletePart(ctx: WorkspaceRequestContext, bookId: string, partId: string, confirmScenes?: number): Promise<{ id: string; outline: OutlineView }> {
    await assertPermission(ctx, 'bible.edit');
    const id = ManuscriptIdParam.parse(partId);
    return runInWorkspaceContext(ctx, async (db) => {
        await ManuscriptRepository.lockStructure(db, bookId);
        await requireBook(db, ctx, bookId);
        await requirePart(db, ctx, bookId, id);
        const chapters = await ManuscriptChapterRepository.listForPart(db, ctx.workspaceId, id, CHAPTERS_PER_MANUSCRIPT_MAX + 1);
        const scenes = await ManuscriptSceneRepository.listForChapters(db, ctx.workspaceId, bookId, chapters.map((c) => c.id), CHILDREN_READ_MAX);
        const recentlyDeleted = await deletedIn(db, ctx, bookId, chapters.map((c) => c.id));
        assertConfirmed(scenes.length, confirmScenes, chapters.length, recentlyDeleted);
        if ((await ManuscriptPartRepository.remove(db, ctx.workspaceId, bookId, id)) === 0) throw new NotFoundError('Part not found.');
        await logEvent(ctx, { action: 'MANUSCRIPT_PART_DELETED', entityType: 'ManuscriptPart', entityId: id, details: { bookId, chapterCount: chapters.length, sceneCount: scenes.length, recentlyDeletedCount: recentlyDeleted } }, { db });
        return { id, outline: await outline(db, ctx, bookId) };
    });
}

// ─── Chapters ───────────────────────────────────────────────────────

export async function createChapter(ctx: WorkspaceRequestContext, bookId: string, input: unknown): Promise<{ id: string; outline: OutlineView }> {
    await assertPermission(ctx, 'bible.edit');
    const parsed = CreateChapterInput.parse(input);
    const name = title(parsed.title);
    return runInWorkspaceContext(ctx, async (db) => {
        await ManuscriptRepository.lockStructure(db, bookId);
        const manuscript = await ensureManuscript(db, ctx, bookId);
        if ((await ManuscriptChapterRepository.count(db, ctx.workspaceId, bookId)) >= CHAPTERS_PER_MANUSCRIPT_MAX) full('TOO_MANY_CHAPTERS');
        let partId = parsed.partId ?? null;
        if (partId) {
            await requirePart(db, ctx, bookId, partId);
        } else {
            const parts = byRank(await ManuscriptPartRepository.list(db, ctx.workspaceId, bookId, PARTS_PER_MANUSCRIPT_MAX + 1));
            partId = parts.length > 0 ? parts[parts.length - 1].id : (await ManuscriptPartRepository.create(db, ctx.workspaceId, { bookId, manuscriptId: manuscript.id, title: null, rank: rankAmong([], {}) })).id;
        }
        const siblings = await ManuscriptChapterRepository.listForPart(db, ctx.workspaceId, partId, CHAPTERS_PER_MANUSCRIPT_MAX + 1);
        const place = await placeAmong(db, ctx, 'chapter', siblings, null, parsed);
        const chapter = await ManuscriptChapterRepository.create(db, ctx.workspaceId, { bookId, partId, title: name, rank: place.rank });
        await logEvent(ctx, { action: 'MANUSCRIPT_CHAPTER_CREATED', entityType: 'ManuscriptChapter', entityId: chapter.id, details: { bookId, partId } }, { db });
        await recordManuscriptRebalance(db, ctx, bookId, 'chapter', partId, place.rebalanced);
        return { id: chapter.id, outline: await outline(db, ctx, bookId) };
    });
}

export async function renameChapter(ctx: WorkspaceRequestContext, bookId: string, chapterId: string, input: unknown): Promise<OutlineView> {
    await assertPermission(ctx, 'bible.edit');
    const id = ManuscriptIdParam.parse(chapterId);
    const name = title(RenameInput.parse(input).title);
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        await requireChapter(db, ctx, bookId, id);
        await ManuscriptChapterRepository.rename(db, ctx.workspaceId, id, name);
        return outline(db, ctx, bookId);
    });
}

export async function moveChapter(ctx: WorkspaceRequestContext, bookId: string, chapterId: string, input: unknown): Promise<OutlineView> {
    await assertPermission(ctx, 'bible.edit');
    const id = ManuscriptIdParam.parse(chapterId);
    const parsed = MoveChapterInput.parse(input);
    return runInWorkspaceContext(ctx, async (db) => {
        await ManuscriptRepository.lockStructure(db, bookId);
        await requireBook(db, ctx, bookId);
        await requireChapter(db, ctx, bookId, id);
        await requirePart(db, ctx, bookId, parsed.partId);
        const siblings = await ManuscriptChapterRepository.listForPart(db, ctx.workspaceId, parsed.partId, CHAPTERS_PER_MANUSCRIPT_MAX + 1);
        const place = await placeAmong(db, ctx, 'chapter', siblings, id, parsed);
        await ManuscriptChapterRepository.move(db, ctx.workspaceId, id, { partId: parsed.partId, rank: place.rank });
        await recordManuscriptRebalance(db, ctx, bookId, 'chapter', parsed.partId, place.rebalanced);
        return outline(db, ctx, bookId);
    });
}

export async function deleteChapter(ctx: WorkspaceRequestContext, bookId: string, chapterId: string, confirmScenes?: number): Promise<{ id: string; outline: OutlineView }> {
    await assertPermission(ctx, 'bible.edit');
    const id = ManuscriptIdParam.parse(chapterId);
    return runInWorkspaceContext(ctx, async (db) => {
        await ManuscriptRepository.lockStructure(db, bookId);
        await requireBook(db, ctx, bookId);
        await requireChapter(db, ctx, bookId, id);
        const scenes = await ManuscriptSceneRepository.listForChapter(db, ctx.workspaceId, id, CHILDREN_READ_MAX);
        const recentlyDeleted = await deletedIn(db, ctx, bookId, [id]);
        assertConfirmed(scenes.length, confirmScenes, undefined, recentlyDeleted);
        if ((await ManuscriptChapterRepository.remove(db, ctx.workspaceId, bookId, id)) === 0) throw new NotFoundError('Chapter not found.');
        await logEvent(ctx, { action: 'MANUSCRIPT_CHAPTER_DELETED', entityType: 'ManuscriptChapter', entityId: id, details: { bookId, sceneCount: scenes.length, recentlyDeletedCount: recentlyDeleted } }, { db });
        return { id, outline: await outline(db, ctx, bookId) };
    });
}

// ─── Scenes ─────────────────────────────────────────────────────────

export async function createScene(ctx: WorkspaceRequestContext, bookId: string, input: unknown): Promise<{ id: string; outline: OutlineView }> {
    await assertPermission(ctx, 'bible.edit');
    const parsed = CreateSceneInput.parse(input);
    const name = title(parsed.title);
    return runInWorkspaceContext(ctx, async (db) => {
        await ManuscriptRepository.lockStructure(db, bookId);
        await requireBook(db, ctx, bookId);
        await requireChapter(db, ctx, bookId, parsed.chapterId);
        if ((await ManuscriptSceneRepository.count(db, ctx.workspaceId, bookId)) >= SCENES_PER_MANUSCRIPT_MAX) full('TOO_MANY_SCENES');
        const siblings = await ManuscriptSceneRepository.listForChapter(db, ctx.workspaceId, parsed.chapterId, CHILDREN_READ_MAX);
        const place = await placeAmong(db, ctx, 'scene', siblings, null, parsed);
        const scene = await ManuscriptSceneRepository.create(db, ctx.workspaceId, { bookId, chapterId: parsed.chapterId, title: name, rank: place.rank });
        await logEvent(ctx, { action: 'MANUSCRIPT_SCENE_CREATED', entityType: 'ManuscriptScene', entityId: scene.id, details: { bookId, chapterId: parsed.chapterId } }, { db });
        await recordManuscriptRebalance(db, ctx, bookId, 'scene', parsed.chapterId, place.rebalanced);
        return { id: scene.id, outline: await outline(db, ctx, bookId) };
    });
}

export async function moveScene(ctx: WorkspaceRequestContext, bookId: string, sceneId: string, input: unknown): Promise<OutlineView> {
    await assertPermission(ctx, 'bible.edit');
    const id = ManuscriptIdParam.parse(sceneId);
    const parsed = MoveSceneInput.parse(input);
    return runInWorkspaceContext(ctx, async (db) => {
        await ManuscriptRepository.lockStructure(db, bookId);
        await requireBook(db, ctx, bookId);
        if (!(await ManuscriptSceneRepository.head(db, ctx.workspaceId, bookId, id))) throw new NotFoundError('Scene not found.');
        await requireChapter(db, ctx, bookId, parsed.chapterId);
        const siblings = await ManuscriptSceneRepository.listForChapter(db, ctx.workspaceId, parsed.chapterId, CHILDREN_READ_MAX);
        const place = await placeAmong(db, ctx, 'scene', siblings, id, parsed);
        await ManuscriptSceneRepository.move(db, ctx.workspaceId, id, { chapterId: parsed.chapterId, rank: place.rank });
        await recordManuscriptRebalance(db, ctx, bookId, 'scene', parsed.chapterId, place.rebalanced);
        return outline(db, ctx, bookId);
    });
}

/**
 * Delete a scene (`bible.edit`). SOFT since 5.H-a (issue #71): the scene leaves the outline and every list at once,
 * and keeps its text, note, card, links, versions and research proposals for `SCENE_RESTORE_DAYS`, restorable from the
 * manuscript's Recently deleted list; then the daily `scene-purge` job deletes it for good. 5.1's undo toast is what
 * undoes a mistaken click before this runs.
 */
export async function deleteScene(ctx: WorkspaceRequestContext, bookId: string, sceneId: string): Promise<{ id: string; outline: OutlineView }> {
    await assertPermission(ctx, 'bible.edit');
    const id = ManuscriptIdParam.parse(sceneId);
    return runInWorkspaceContext(ctx, async (db) => {
        await ManuscriptRepository.lockStructure(db, bookId);
        await requireBook(db, ctx, bookId);
        await ManuscriptRepository.lockScene(db, id);
        const head = await ManuscriptSceneRepository.head(db, ctx.workspaceId, bookId, id);
        // The scene's ROW, as every save takes it (a save waiting on it sees the scene deleted, never half of it).
        if (!head || !(await ManuscriptRepository.lockSceneRow(db, ctx.workspaceId, id))) throw new NotFoundError('Scene not found.');
        if ((await ManuscriptSceneRepository.softDelete(db, ctx.workspaceId, bookId, id)) === 0) throw new NotFoundError('Scene not found.');
        await logEvent(ctx, { action: 'MANUSCRIPT_SCENE_DELETED', entityType: 'ManuscriptScene', entityId: id, details: { bookId, chapterId: head.chapterId, wordCount: head.wordCount } }, { db });
        return { id, outline: await outline(db, ctx, bookId) };
    });
}

// ─── Recently deleted scenes (Phase 5.H-a, issue #71) ────────────────

export interface DeletedSceneView {
    id: string;
    title: string | null;
    wordCount: number;
    chapterId: string;
    chapterTitle: string | null;
    deletedAt: string;
    restorableUntil: string;
}

/** A manuscript's scenes deleted in the last `SCENE_RESTORE_DAYS` days, newest first (`bible.view`; restoring is `bible.edit`). */
export async function listDeletedScenes(ctx: WorkspaceRequestContext, bookId: string): Promise<{ scenes: DeletedSceneView[]; truncated: boolean }> {
    await assertPermission(ctx, 'bible.view');
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        const since = sceneRestoreCutoff(await ManuscriptRepository.dbNow(db));
        const rows = await ManuscriptSceneRepository.listDeleted(db, ctx.workspaceId, bookId, since, DELETED_SCENES_LISTED_MAX + 1);
        return {
            scenes: rows.slice(0, DELETED_SCENES_LISTED_MAX).map((r) => ({
                id: r.id,
                title: r.title,
                wordCount: r.wordCount,
                chapterId: r.chapterId,
                chapterTitle: r.chapter.title,
                deletedAt: r.deletedAt!.toISOString(),
                restorableUntil: sceneRestorableUntil(r.deletedAt!).toISOString(),
            })),
            truncated: rows.length > DELETED_SCENES_LISTED_MAX,
        };
    });
}

/**
 * Bring back a scene deleted in the last 30 days (`bible.edit`), by the DATABASE's clock, with everything it held: its
 * text, note, card, links, versions and research proposals were kept, so nothing is rewritten but its place. It goes
 * back to its place in its chapter when no live scene holds that rank, else to the end of its chapter (`placement`
 * says which). Past the window, never deleted, or another book's: 404. The manuscript's scene bound still holds
 * (409 TOO_MANY_SCENES). Audited with ids and counts.
 */
export async function restoreScene(ctx: WorkspaceRequestContext, bookId: string, sceneId: string): Promise<{ id: string; placement: 'ORIGINAL' | 'END_OF_CHAPTER'; outline: OutlineView }> {
    await assertPermission(ctx, 'bible.edit');
    const id = ManuscriptIdParam.parse(sceneId);
    return runInWorkspaceContext(ctx, async (db) => {
        await ManuscriptRepository.lockStructure(db, bookId);
        await requireBook(db, ctx, bookId);
        await ManuscriptRepository.lockScene(db, id);
        const since = sceneRestoreCutoff(await ManuscriptRepository.dbNow(db));
        const deleted = await ManuscriptSceneRepository.findDeleted(db, ctx.workspaceId, bookId, id, since);
        if (!deleted) throw new NotFoundError('Scene not found.');
        if ((await ManuscriptSceneRepository.count(db, ctx.workspaceId, bookId)) >= SCENES_PER_MANUSCRIPT_MAX) full('TOO_MANY_SCENES');
        const siblings = await ManuscriptSceneRepository.listForChapter(db, ctx.workspaceId, deleted.chapterId, CHILDREN_READ_MAX);
        const taken = siblings.some((s) => s.rank === deleted.rank);
        let rank = deleted.rank;
        let rebalanced = 0;
        if (taken) {
            const last = byRank(siblings).at(-1);
            const place = await placeAmong(db, ctx, 'scene', siblings, null, last ? { after: last.id } : {});
            rank = place.rank;
            rebalanced = place.rebalanced;
        }
        if ((await ManuscriptSceneRepository.restore(db, ctx.workspaceId, bookId, id, since, rank)) === 0) throw new NotFoundError('Scene not found.');
        await logEvent(
            ctx,
            { action: 'MANUSCRIPT_SCENE_UNDELETED', entityType: 'ManuscriptScene', entityId: id, details: { bookId, chapterId: deleted.chapterId, wordCount: deleted.wordCount, placement: taken ? 'END_OF_CHAPTER' : 'ORIGINAL' } },
            { db },
        );
        await recordManuscriptRebalance(db, ctx, bookId, 'scene', deleted.chapterId, rebalanced);
        return { id, placement: taken ? 'END_OF_CHAPTER' : 'ORIGINAL', outline: await outline(db, ctx, bookId) };
    });
}

