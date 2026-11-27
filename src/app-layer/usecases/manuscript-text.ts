/**
 * THE SCENE TEXT WRITER (Phase 5.1; D3, D33). The one module that writes a
 * scene's text column, or a version of it:
 *
 *   writeSceneText        an autosave: the editor's HTML, sanitised (the prose
 *                         profile), its mentions kept only for elements of the
 *                         scene's book, its words counted, the revision moved
 *                         on, the links re-derived from the mentions, and — at
 *                         a checkpoint or past the server's bound — a version
 *   checkpointSceneText   a checkpoint with no text (the author left): a
 *                         version of the stored text, when it is the revision
 *                         the tab saved and differs from the newest version
 *   restoreSceneText      an old version's text as a NEW save and version
 *   createImportedScenes  an import's scenes, their first versions with them
 *
 * D3: NO MODEL OUTPUT IS EVER WRITTEN HERE. The text an author types (or the
 * file they import, or a version they wrote) is the only input; nothing in
 * this module's import graph reaches the model layer, and no module that does
 * may import this one (`tests/guards/scene-text-stays-off-the-model-path.test.ts`,
 * which also holds `ManuscriptSceneRepository.setText` / `.createScenes` and
 * `SceneVersionRepository`'s writes to this file). A research finding reaches
 * a scene only as its NOTE (`manuscript-notes.ts`).
 *
 * WHEN A VERSION IS WRITTEN (D33, owner decision 2026-11-27): autosave keeps
 * the text safe continuously; history is written when the author pauses or
 * leaves. A save writes a version only when its text differs from the newest
 * version AND either the client said `checkpoint` (an idle pause of about two
 * minutes, leaving the scene, the tab hidden or closed) or the newest version
 * is older than `SCENE_VERSION_MAX_GAP_MS` by the database's clock (so a
 * checkpoint the network lost still bounds the gap), or the scene has none.
 *
 * Every function runs in the caller's transaction, under the scene's lock
 * (`ManuscriptRepository.lockScene`), after the caller checked the revision.
 * LOCK ORDER: the elements a text names are locked FOR KEY SHARE before any
 * link or scene row is written (`ManuscriptRepository.lockElements`).
 */
import { randomUUID } from 'node:crypto';
import type { WorkspaceRequestContext } from '@/app-layer/types';
import {
    ManuscriptRepository,
    ManuscriptSceneRepository,
    SceneLinkRepository,
    SceneVersionRepository,
    type SceneHeadRow,
} from '@/app-layer/repositories/manuscript.repository';
import type { PrismaTx } from '@/lib/db/rls-middleware';
import { NotFoundError, ValidationError } from '@/lib/errors/types';
import { countSceneWords, mentionCandidates, mentionIdsOf, paragraphsAsHtml, storableSceneHtml } from '@/lib/manuscript/scene-html';
import { sanitiseManuscriptTitle } from '@/lib/manuscript/storage';
import { SCENE_LINKS_MAX, SCENE_TEXT_MAX_CHARS, SCENE_VERSION_MAX_GAP_MS } from '@/lib/manuscript/vocabulary';

/** Mention links a scene keeps at most (mentions past it stay in the text, unlinked, and are counted). */
export const MENTION_LINKS_MAX = 200;

/** An imported scene's id, minted here so its version can name it in the same batch (lower-case hex, as an id is matched by `MENTION_ID`). */
function newSceneId(): string {
    return randomUUID().replace(/-/g, '');
}

/** Scenes inserted per statement by an import. */
const IMPORT_INSERT_BATCH = 500;

export interface SceneTextResult {
    /** The scene's revision after the save (unchanged when the text was). */
    revision: number;
    wordCount: number;
    /** The version this save wrote, or null. */
    versionNumber: number | null;
    /** Mentioned elements the text holds but the scene did not link (past `MENTION_LINKS_MAX`). */
    mentionsCut: number;
    /** The save changed the scene's links (the editor's side panel reads them again). */
    linksChanged: boolean;
}

function tooLongText(): never {
    throw new ValidationError('This scene is too long to store; split it.', { reason: 'TOO_LONG', field: 'text' });
}

/** Re-derive the scene's mention links from its stored text (explicit links are left as they are). */
async function syncMentionLinks(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, sceneId: string, stored: string): Promise<{ cut: number; changed: boolean }> {
    const all = mentionIdsOf(stored);
    const mentioned = new Set(all.slice(0, MENTION_LINKS_MAX));
    const rows = await SceneLinkRepository.listForScene(db, ctx.workspaceId, sceneId, MENTION_LINKS_MAX + SCENE_LINKS_MAX + 1);
    const have = new Map(rows.map((r) => [r.elementId, r] as const));
    const remove: string[] = [];
    let changed = false;
    for (const r of rows) {
        const now = mentioned.has(r.elementId);
        if (now === r.mentioned) continue;
        changed = true;
        if (!now && !r.explicit) remove.push(r.elementId);
        else await SceneLinkRepository.upsert(db, ctx.workspaceId, bookId, sceneId, r.elementId, { mentioned: now, explicit: r.explicit });
    }
    for (const id of mentioned) {
        if (have.has(id)) continue;
        changed = true;
        await SceneLinkRepository.upsert(db, ctx.workspaceId, bookId, sceneId, id, { mentioned: true, explicit: false });
    }
    await SceneLinkRepository.removeMany(db, ctx.workspaceId, sceneId, remove);
    return { cut: all.length - mentioned.size, changed };
}

/** The newest version, and whether one is due for `stored` (D33's rule). */
async function versionDue(db: PrismaTx, ctx: WorkspaceRequestContext, sceneId: string, stored: string, checkpoint: boolean, now: Date | undefined) {
    const latest = await SceneVersionRepository.latest(db, ctx.workspaceId, sceneId);
    if (!latest) return { latest, due: stored !== '' };
    if (latest.text === stored) return { latest, due: false };
    if (checkpoint) return { latest, due: true };
    const clock = now ?? (await ManuscriptRepository.dbNow(db));
    return { latest, due: clock.getTime() - latest.createdAt.getTime() >= SCENE_VERSION_MAX_GAP_MS };
}

/** An autosave of the scene's text (the caller holds the scene's lock and checked `baseRevision`). */
export async function writeSceneText(
    db: PrismaTx,
    ctx: WorkspaceRequestContext,
    head: SceneHeadRow,
    raw: string,
    opts: { checkpoint: boolean; now?: Date },
): Promise<SceneTextResult> {
    // Elements first (FOR KEY SHARE), then the scene's rows: the book's lock order.
    const elements = await ManuscriptRepository.lockElements(db, ctx.workspaceId, head.bookId, mentionCandidates(raw));
    const stored = storableSceneHtml(raw, (id) => elements.has(id));
    if (stored.length > SCENE_TEXT_MAX_CHARS) tooLongText();
    const scene = await ManuscriptSceneRepository.find(db, ctx.workspaceId, head.bookId, head.id);
    if (!scene) throw new NotFoundError('Scene not found.');
    let revision = scene.revision;
    let wordCount = scene.wordCount;
    let mentionsCut = 0;
    let linksChanged = false;
    if (stored !== scene.text) {
        revision = scene.revision + 1;
        wordCount = countSceneWords(stored);
        ({ cut: mentionsCut, changed: linksChanged } = await syncMentionLinks(db, ctx, head.bookId, head.id, stored));
        await ManuscriptSceneRepository.setText(db, ctx.workspaceId, head.id, { text: stored, wordCount, revision });
    }
    const { latest, due } = await versionDue(db, ctx, head.id, stored, opts.checkpoint, opts.now);
    let versionNumber: number | null = null;
    if (due) {
        versionNumber = (latest?.versionNumber ?? 0) + 1;
        await SceneVersionRepository.create(db, ctx.workspaceId, { bookId: head.bookId, sceneId: head.id, versionNumber, text: stored, wordCount, source: 'EDIT', restoredFromVersion: null, authorId: ctx.userId });
    }
    return { revision, wordCount, versionNumber, mentionsCut, linksChanged };
}

/**
 * A checkpoint with no text: the stored text as a version, when the scene is
 * still at the revision the tab last saved (another tab's newer save is its
 * own to checkpoint) and it differs from the newest version.
 */
export async function checkpointSceneText(db: PrismaTx, ctx: WorkspaceRequestContext, head: SceneHeadRow, revision: number): Promise<{ versionNumber: number | null }> {
    if (head.revision !== revision) return { versionNumber: null };
    const scene = await ManuscriptSceneRepository.find(db, ctx.workspaceId, head.bookId, head.id);
    if (!scene) throw new NotFoundError('Scene not found.');
    const { latest, due } = await versionDue(db, ctx, head.id, scene.text, true, undefined);
    if (!due) return { versionNumber: null };
    const versionNumber = (latest?.versionNumber ?? 0) + 1;
    await SceneVersionRepository.create(db, ctx.workspaceId, { bookId: head.bookId, sceneId: head.id, versionNumber, text: scene.text, wordCount: scene.wordCount, source: 'EDIT', restoredFromVersion: null, authorId: ctx.userId });
    return { versionNumber };
}

/** An old version's text applied as a new save and a new version (RESTORE). A mention of an element since deleted becomes plain text. */
export async function restoreSceneText(db: PrismaTx, ctx: WorkspaceRequestContext, head: SceneHeadRow, version: { versionNumber: number; text: string }): Promise<SceneTextResult> {
    const elements = await ManuscriptRepository.lockElements(db, ctx.workspaceId, head.bookId, mentionCandidates(version.text));
    const stored = storableSceneHtml(version.text, (id) => elements.has(id));
    if (stored.length > SCENE_TEXT_MAX_CHARS) tooLongText();
    const revision = head.revision + 1;
    const wordCount = countSceneWords(stored);
    const { cut: mentionsCut, changed: linksChanged } = await syncMentionLinks(db, ctx, head.bookId, head.id, stored);
    await ManuscriptSceneRepository.setText(db, ctx.workspaceId, head.id, { text: stored, wordCount, revision });
    const latest = await SceneVersionRepository.latest(db, ctx.workspaceId, head.id);
    const versionNumber = (latest?.versionNumber ?? 0) + 1;
    await SceneVersionRepository.create(db, ctx.workspaceId, {
        bookId: head.bookId,
        sceneId: head.id,
        versionNumber,
        text: stored,
        wordCount,
        source: 'RESTORE',
        restoredFromVersion: version.versionNumber,
        authorId: ctx.userId,
    });
    return { revision, wordCount, versionNumber, mentionsCut, linksChanged };
}

export interface ImportedScene {
    chapterId: string;
    rank: string;
    /** The heading's words, raw (sanitised here). */
    title: string | null;
    /** The section's paragraphs, plain text (escaped into prose HTML here). */
    paragraphs: readonly string[];
}

/**
 * An import's scenes, in batches of `IMPORT_INSERT_BATCH` a statement, each
 * with its first version (IMPORT) when it holds text: a constant number of
 * statements a batch, so the work is linear in the manuscript. An imported text
 * holds no mention (every character was escaped). Returns the scenes' ids and
 * their total words.
 */
export async function createImportedScenes(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, scenes: readonly ImportedScene[]): Promise<{ ids: string[]; words: number }> {
    const rows = scenes.map((s) => {
        const text = storableSceneHtml(paragraphsAsHtml(s.paragraphs), () => false);
        if (text.length > SCENE_TEXT_MAX_CHARS) tooLongText();
        return { id: newSceneId(), chapterId: s.chapterId, title: sanitiseManuscriptTitle(s.title), rank: s.rank, text, wordCount: countSceneWords(text) };
    });
    for (let i = 0; i < rows.length; i += IMPORT_INSERT_BATCH) {
        const batch = rows.slice(i, i + IMPORT_INSERT_BATCH);
        await ManuscriptSceneRepository.createScenes(db, ctx.workspaceId, bookId, batch);
        const versions = batch.filter((r) => r.text !== '').map((r) => ({ sceneId: r.id, text: r.text, wordCount: r.wordCount }));
        if (versions.length > 0) await SceneVersionRepository.createMany(db, ctx.workspaceId, bookId, versions, ctx.userId);
    }
    return { ids: rows.map((r) => r.id), words: rows.reduce((n, r) => n + r.wordCount, 0) };
}
