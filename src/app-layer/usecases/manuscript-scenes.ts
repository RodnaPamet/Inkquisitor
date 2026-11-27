/**
 * A scene (Phase 5.1, D33): read it for the editor; save its text (autosave),
 * checkpoint it, change its details (title, point of view, setting, story time,
 * linked elements, the plot beats it dramatises) and its note; list, read and
 * restore its versions; and list the scenes of a beat.
 *
 * Every call asks its permission first (`bible.view` reads, `bible.edit`
 * writes) and runs inside `runInWorkspaceContext`; every write takes the
 * scene's lock (`ManuscriptRepository.lockScene`) and names the revision it
 * was based on: a newer one refuses it 409 `VERSION_CONFLICT` with
 * `currentRevision`, writing nothing (the editor holds the edit and offers
 * reload or keep, never a silent overwrite). The note has its own counter
 * (`baseNoteVersion`, 409 `VERSION_CONFLICT` with `currentNoteVersion`).
 *
 * THE TEXT goes through `manuscript-text.ts` and nowhere else (D3). Its links
 * are derived from its mentions on every text save; the details save sets the
 * explicit ones. Every element a scene names is of its book (the composite
 * keys) and of the right kind (the triggers; asked here first so the author
 * reads a 400 naming the field: UNKNOWN_ELEMENT, WRONG_KIND).
 *
 * An autosave writes no audit row (it would flood the trail); a restore does.
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { logEvent } from '@/app-layer/events/audit';
import { assertPermission } from '@/app-layer/policies/permission.policy';
import {
    ManuscriptChapterRepository,
    ManuscriptPartRepository,
    ManuscriptRepository,
    ManuscriptSceneRepository,
    SceneBeatRepository,
    SceneLinkRepository,
    SceneVersionRepository,
    type SceneHeadRow,
} from '@/app-layer/repositories/manuscript.repository';
import { VersionNumberParam } from '@/app-layer/schemas/bible';
import { CheckpointInput, ManuscriptIdParam, RestoreSceneInput, SaveSceneNoteInput, SaveSceneTextInput, SceneMetaInput } from '@/app-layer/schemas/manuscript';
import { runInWorkspaceContext, type PrismaTx } from '@/lib/db/rls-middleware';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors/types';
import { compareRanks } from '@/lib/bible/story-order';
import { sanitiseManuscriptTitle, sanitiseStoryTime } from '@/lib/manuscript/storage';
import { BEAT_SCENES_MAX, PARTS_PER_MANUSCRIPT_MAX, SCENE_BEATS_MAX, SCENE_LINKS_MAX, SCENE_VERSION_PAGE_SIZE, type SceneVersionSource } from '@/lib/manuscript/vocabulary';
import { requireBook, requireElement } from './bible-common';
import { readOutlineRows, requireScene, tooLong } from './manuscript-common';
import { writeSceneNoteInTx } from './manuscript-notes';
import { checkpointSceneText, MENTION_LINKS_MAX, restoreSceneText, writeSceneText, type SceneTextResult } from './manuscript-text';

// ─── Views ──────────────────────────────────────────────────────────

export interface SceneLinkView {
    elementId: string;
    kind: string;
    name: string;
    /** The element's summary, decrypted on the server (the side panel shows it as text). */
    summary: string | null;
    mentioned: boolean;
    explicit: boolean;
}

export interface SceneElementRef {
    id: string;
    name: string;
}

export interface SceneView {
    id: string;
    bookId: string;
    chapterId: string;
    chapterTitle: string | null;
    title: string | null;
    text: string;
    wordCount: number;
    revision: number;
    storyTime: string | null;
    note: string | null;
    noteVersion: number;
    pov: SceneElementRef | null;
    setting: SceneElementRef | null;
    links: SceneLinkView[];
    beats: SceneElementRef[];
    /** The newest version's number (0: none yet). */
    latestVersion: number;
    /** Words in the scene's chapter and in the whole manuscript (aggregates; the editor adds its live change). */
    chapterWords: number;
    manuscriptWords: number;
    /** The scenes before and after it in manuscript order (chapter rank, then scene rank), for the editor's navigation. */
    previousSceneId: string | null;
    nextSceneId: string | null;
}

async function sceneView(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, sceneId: string): Promise<SceneView> {
    const scene = await ManuscriptSceneRepository.find(db, ctx.workspaceId, bookId, sceneId);
    if (!scene) throw new NotFoundError('Scene not found.');
    const links = await SceneLinkRepository.listForScene(db, ctx.workspaceId, sceneId, MENTION_LINKS_MAX + SCENE_LINKS_MAX);
    const beats = await SceneBeatRepository.listForScene(db, ctx.workspaceId, sceneId, SCENE_BEATS_MAX + 1);
    const ids = [...new Set([...links.map((l) => l.elementId), ...beats.map((b) => b.beatElementId), ...(scene.povElementId ? [scene.povElementId] : []), ...(scene.settingElementId ? [scene.settingElementId] : [])])];
    const elements = new Map((await ManuscriptRepository.elementsByIds(db, ctx.workspaceId, bookId, ids)).map((e) => [e.id, e] as const));
    const ref = (id: string | null): SceneElementRef | null => {
        const e = id ? elements.get(id) : undefined;
        return e ? { id: e.id, name: e.name } : null;
    };
    const rows = await readOutlineRows(db, ctx, bookId);
    const partRank = new Map(rows.parts.map((p) => [p.id, p.rank] as const));
    const chapterOf = new Map(rows.chapters.map((c) => [c.id, c] as const));
    const ordered = [...rows.scenes].sort((a, b) => {
        const ca = chapterOf.get(a.chapterId);
        const cb = chapterOf.get(b.chapterId);
        return (
            compareRanks(partRank.get(ca?.partId ?? '') ?? '', partRank.get(cb?.partId ?? '') ?? '') ||
            compareRanks(ca?.rank ?? '', cb?.rank ?? '') ||
            compareRanks(a.rank, b.rank)
        );
    });
    const at = ordered.findIndex((s) => s.id === sceneId);
    const latest = await SceneVersionRepository.latest(db, ctx.workspaceId, sceneId);
    return {
        id: scene.id,
        bookId,
        chapterId: scene.chapterId,
        chapterTitle: chapterOf.get(scene.chapterId)?.title ?? null,
        title: scene.title,
        text: scene.text,
        wordCount: scene.wordCount,
        revision: scene.revision,
        storyTime: scene.storyTime,
        note: scene.note,
        noteVersion: scene.noteVersion,
        pov: ref(scene.povElementId),
        setting: ref(scene.settingElementId),
        links: links
            .flatMap((l): SceneLinkView[] => {
                const e = elements.get(l.elementId);
                return e ? [{ elementId: e.id, kind: e.kind, name: e.name, summary: e.summary, mentioned: l.mentioned, explicit: l.explicit }] : [];
            })
            .sort((a, b) => a.name.localeCompare(b.name)),
        beats: beats.map((b) => ref(b.beatElementId)).filter((b): b is SceneElementRef => b !== null),
        latestVersion: latest?.versionNumber ?? 0,
        chapterWords: rows.scenes.filter((s) => s.chapterId === scene.chapterId).reduce((n, s) => n + s.wordCount, 0),
        manuscriptWords: rows.scenes.reduce((n, s) => n + s.wordCount, 0),
        previousSceneId: at > 0 ? ordered[at - 1].id : null,
        nextSceneId: at >= 0 && at < ordered.length - 1 ? ordered[at + 1].id : null,
    };
}

/** The scene for the editor (`bible.view`). */
export async function getScene(ctx: WorkspaceRequestContext, bookId: string, sceneId: string): Promise<SceneView> {
    await assertPermission(ctx, 'bible.view');
    const id = ManuscriptIdParam.parse(sceneId);
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        return sceneView(db, ctx, bookId, id);
    });
}

function assertRevision(head: SceneHeadRow, baseRevision: number): void {
    if (head.revision !== baseRevision) {
        throw new ConflictError('This scene was saved elsewhere since your edit began.', { reason: 'VERSION_CONFLICT', currentRevision: head.revision, baseRevision });
    }
}

// ─── The text ───────────────────────────────────────────────────────

export interface SceneTextSaveDeps {
    /** The clock a version's age is judged by (tests); omitted: the database's. */
    now?: Date;
}

/** An autosave (`bible.edit`): the editor's whole HTML, its base revision, and whether it is a checkpoint (D33). */
export async function saveSceneText(ctx: WorkspaceRequestContext, bookId: string, sceneId: string, input: unknown, deps: SceneTextSaveDeps = {}): Promise<SceneTextResult> {
    await assertPermission(ctx, 'bible.edit');
    const id = ManuscriptIdParam.parse(sceneId);
    const parsed = SaveSceneTextInput.parse(input);
    return runInWorkspaceContext(
        ctx,
        async (db) => {
            await requireBook(db, ctx, bookId);
            await ManuscriptRepository.lockScene(db, id);
            const head = await requireScene(db, ctx, bookId, id);
            assertRevision(head, parsed.baseRevision);
            return writeSceneText(db, ctx, head, parsed.html, { checkpoint: parsed.checkpoint === true, now: deps.now });
        },
        { timeout: 30_000 },
    );
}

/** A checkpoint with no text (`bible.edit`): sent as the author leaves, so it fits a `keepalive` request (D33). */
export async function checkpointScene(ctx: WorkspaceRequestContext, bookId: string, sceneId: string, input: unknown): Promise<{ versionNumber: number | null }> {
    await assertPermission(ctx, 'bible.edit');
    const id = ManuscriptIdParam.parse(sceneId);
    const parsed = CheckpointInput.parse(input);
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        await ManuscriptRepository.lockScene(db, id);
        const head = await requireScene(db, ctx, bookId, id);
        return checkpointSceneText(db, ctx, head, parsed.revision);
    });
}

// ─── The details ────────────────────────────────────────────────────

/** Change the scene's details (`bible.edit`): each key left out is left as it is. Returns the scene. */
export async function updateSceneMeta(ctx: WorkspaceRequestContext, bookId: string, sceneId: string, input: unknown): Promise<SceneView> {
    await assertPermission(ctx, 'bible.edit');
    const id = ManuscriptIdParam.parse(sceneId);
    const parsed = SceneMetaInput.parse(input);
    let title: string | null | undefined;
    let storyTime: string | null | undefined;
    try {
        title = parsed.title === undefined ? undefined : sanitiseManuscriptTitle(parsed.title);
        storyTime = parsed.storyTime === undefined ? undefined : sanitiseStoryTime(parsed.storyTime);
    } catch (err) {
        tooLong(err);
    }
    const linked = parsed.linkedElementIds === undefined ? undefined : [...new Set(parsed.linkedElementIds)];
    const beats = parsed.beatElementIds === undefined ? undefined : [...new Set(parsed.beatElementIds)];
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        await ManuscriptRepository.lockScene(db, id);
        const head = await requireScene(db, ctx, bookId, id);
        assertRevision(head, parsed.baseRevision);
        const named = [
            ...(parsed.povElementId ? [parsed.povElementId] : []),
            ...(parsed.settingElementId ? [parsed.settingElementId] : []),
            ...(linked ?? []),
            ...(beats ?? []),
        ];
        // Elements first (FOR KEY SHARE), then the scene's rows: the book's lock order.
        const elements = await ManuscriptRepository.lockElements(db, ctx.workspaceId, bookId, [...new Set(named)]);
        const check = (field: string, ids: readonly string[], kind?: string) => {
            for (const e of ids) {
                const found = elements.get(e);
                if (!found) throw new ValidationError('That element is not in this book.', { reason: 'UNKNOWN_ELEMENT', field });
                if (kind && found.kind !== kind) throw new ValidationError('That element is the wrong kind for this field.', { reason: 'WRONG_KIND', field });
            }
        };
        if (parsed.povElementId) check('povElementId', [parsed.povElementId], 'CHARACTER');
        if (parsed.settingElementId) check('settingElementId', [parsed.settingElementId], 'SETTING');
        if (linked) check('linkedElementIds', linked);
        if (beats) check('beatElementIds', beats, 'PLOT_BEAT');

        // The scene's row before any link row (`lockSceneRow`: a part or chapter deletion's cascade order).
        if (!(await ManuscriptRepository.lockSceneRow(db, ctx.workspaceId, id))) throw new NotFoundError('Scene not found.');
        const scene = await ManuscriptSceneRepository.find(db, ctx.workspaceId, bookId, id);
        if (!scene) throw new NotFoundError('Scene not found.');
        if (linked) {
            const rows = await SceneLinkRepository.listForScene(db, ctx.workspaceId, id, MENTION_LINKS_MAX + SCENE_LINKS_MAX + 1);
            const want = new Set(linked);
            const remove: string[] = [];
            for (const r of rows) {
                const explicit = want.has(r.elementId);
                if (explicit === r.explicit) continue;
                if (!explicit && !r.mentioned) remove.push(r.elementId);
                else await SceneLinkRepository.upsert(db, ctx.workspaceId, bookId, id, r.elementId, { mentioned: r.mentioned, explicit });
            }
            const have = new Set(rows.map((r) => r.elementId));
            for (const e of linked) if (!have.has(e)) await SceneLinkRepository.upsert(db, ctx.workspaceId, bookId, id, e, { mentioned: false, explicit: true });
            await SceneLinkRepository.removeMany(db, ctx.workspaceId, id, remove);
        }
        if (beats) {
            const current = (await SceneBeatRepository.listForScene(db, ctx.workspaceId, id, SCENE_BEATS_MAX + 1)).map((b) => b.beatElementId);
            await SceneBeatRepository.removeMany(db, ctx.workspaceId, id, current.filter((b) => !beats.includes(b)));
            await SceneBeatRepository.add(db, ctx.workspaceId, bookId, id, beats.filter((b) => !current.includes(b)));
        }
        await ManuscriptSceneRepository.updateMeta(db, ctx.workspaceId, id, {
            title: title === undefined ? scene.title : title,
            povElementId: parsed.povElementId === undefined ? scene.povElementId : parsed.povElementId,
            settingElementId: parsed.settingElementId === undefined ? scene.settingElementId : parsed.settingElementId,
            storyTime: storyTime === undefined ? scene.storyTime : storyTime,
            revision: scene.revision + 1,
        });
        return sceneView(db, ctx, bookId, id);
    });
}

/** Change the scene's note by hand (`bible.edit`): one MANUAL note version when it changed. */
export async function saveSceneNote(ctx: WorkspaceRequestContext, bookId: string, sceneId: string, input: unknown): Promise<{ noteVersion: number; note: string | null }> {
    await assertPermission(ctx, 'bible.edit');
    const id = ManuscriptIdParam.parse(sceneId);
    const parsed = SaveSceneNoteInput.parse(input);
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        await ManuscriptRepository.lockScene(db, id);
        const head = await requireScene(db, ctx, bookId, id);
        if (head.noteVersion !== parsed.baseNoteVersion) {
            throw new ConflictError('This note was saved elsewhere since your edit began.', { reason: 'VERSION_CONFLICT', currentNoteVersion: head.noteVersion, baseNoteVersion: parsed.baseNoteVersion });
        }
        const result = await writeSceneNoteInTx(db, ctx, bookId, id, parsed.note, { source: 'MANUAL' });
        const scene = await ManuscriptSceneRepository.find(db, ctx.workspaceId, bookId, id);
        return { noteVersion: result.noteVersion, note: scene?.note ?? null };
    });
}

// ─── Versions ───────────────────────────────────────────────────────

export interface SceneVersionMetaView {
    versionNumber: number;
    wordCount: number;
    source: SceneVersionSource;
    restoredFromVersion: number | null;
    createdAt: string;
}

export interface SceneVersionPage {
    versions: SceneVersionMetaView[];
    /** The `before` of the next (older) page, or null. */
    nextBefore: number | null;
}

/** One page of the scene's versions, newest first (`bible.view`). A deleted scene's history stays with the book but is not listed here. */
export async function listSceneVersions(ctx: WorkspaceRequestContext, bookId: string, sceneId: string, before?: unknown): Promise<SceneVersionPage> {
    await assertPermission(ctx, 'bible.view');
    const id = ManuscriptIdParam.parse(sceneId);
    const cursor = before === undefined || before === null || before === '' ? undefined : VersionNumberParam.parse(before);
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        await requireScene(db, ctx, bookId, id);
        const rows = await SceneVersionRepository.list(db, ctx.workspaceId, bookId, id, { before: cursor, take: SCENE_VERSION_PAGE_SIZE + 1 });
        const page = rows.slice(0, SCENE_VERSION_PAGE_SIZE);
        return {
            versions: page.map((v) => ({ versionNumber: v.versionNumber, wordCount: v.wordCount, source: v.source, restoredFromVersion: v.restoredFromVersion, createdAt: v.createdAt.toISOString() })),
            nextBefore: rows.length > SCENE_VERSION_PAGE_SIZE ? page[page.length - 1].versionNumber : null,
        };
    });
}

/** One version's text (`bible.view`). */
export async function getSceneVersion(ctx: WorkspaceRequestContext, bookId: string, sceneId: string, versionNumber: unknown): Promise<SceneVersionMetaView & { text: string }> {
    await assertPermission(ctx, 'bible.view');
    const id = ManuscriptIdParam.parse(sceneId);
    const n = VersionNumberParam.parse(versionNumber);
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        await requireScene(db, ctx, bookId, id);
        const v = await SceneVersionRepository.find(db, ctx.workspaceId, bookId, id, n);
        if (!v) throw new NotFoundError('Version not found.');
        return { versionNumber: v.versionNumber, wordCount: v.wordCount, source: v.source, restoredFromVersion: v.restoredFromVersion, createdAt: v.createdAt.toISOString(), text: v.text };
    });
}

/** Restore a version (`bible.edit`): its text as a NEW save and version; `baseRevision` checked. */
export async function restoreSceneVersion(ctx: WorkspaceRequestContext, bookId: string, sceneId: string, versionNumber: unknown, input: unknown): Promise<SceneTextResult> {
    await assertPermission(ctx, 'bible.edit');
    const id = ManuscriptIdParam.parse(sceneId);
    const n = VersionNumberParam.parse(versionNumber);
    const parsed = RestoreSceneInput.parse(input);
    return runInWorkspaceContext(
        ctx,
        async (db) => {
            await requireBook(db, ctx, bookId);
            await ManuscriptRepository.lockScene(db, id);
            const head = await requireScene(db, ctx, bookId, id);
            assertRevision(head, parsed.baseRevision);
            const version = await SceneVersionRepository.find(db, ctx.workspaceId, bookId, id, n);
            if (!version) throw new NotFoundError('Version not found.');
            const result = await restoreSceneText(db, ctx, head, version);
            await logEvent(
                ctx,
                { action: 'MANUSCRIPT_SCENE_RESTORED', entityType: 'ManuscriptScene', entityId: id, details: { bookId, restoredFromVersion: n, versionNumber: result.versionNumber } },
                { db },
            );
            return result;
        },
        { timeout: 30_000 },
    );
}

// ─── A beat's scenes ────────────────────────────────────────────────

export interface BeatSceneView {
    sceneId: string;
    title: string | null;
    chapterId: string;
    chapterTitle: string | null;
}

/** The scenes that dramatise a plot beat (`bible.view`), in manuscript order; at most `BEAT_SCENES_MAX`, a cut named. */
export async function listBeatScenes(ctx: WorkspaceRequestContext, bookId: string, elementId: string): Promise<{ scenes: BeatSceneView[]; truncated: boolean }> {
    await assertPermission(ctx, 'bible.view');
    return runInWorkspaceContext(ctx, (db) => beatScenesInTx(db, ctx, bookId, elementId));
}

/** The same, in the caller's transaction (the element page reads it beside the element). */
export async function beatScenesInTx(db: PrismaTx, ctx: WorkspaceRequestContext, bookId: string, elementId: string): Promise<{ scenes: BeatSceneView[]; truncated: boolean }> {
    await requireBook(db, ctx, bookId);
    await requireElement(db, ctx, bookId, elementId);
    const links = await SceneBeatRepository.scenesOf(db, ctx.workspaceId, bookId, elementId, BEAT_SCENES_MAX + 1);
    const scenes = await ManuscriptSceneRepository.findOutline(db, ctx.workspaceId, bookId, links.slice(0, BEAT_SCENES_MAX).map((l) => l.sceneId));
    const chapters = new Map((await ManuscriptChapterRepository.findByIds(db, ctx.workspaceId, bookId, [...new Set(scenes.map((s) => s.chapterId))])).map((c) => [c.id, c] as const));
    const parts = new Map((await ManuscriptPartRepository.list(db, ctx.workspaceId, bookId, PARTS_PER_MANUSCRIPT_MAX + 1)).map((p) => [p.id, p.rank] as const));
    const ordered = [...scenes].sort((a, b) => {
        const ca = chapters.get(a.chapterId);
        const cb = chapters.get(b.chapterId);
        return compareRanks(parts.get(ca?.partId ?? '') ?? '', parts.get(cb?.partId ?? '') ?? '') || compareRanks(ca?.rank ?? '', cb?.rank ?? '') || compareRanks(a.rank, b.rank);
    });
    return {
        scenes: ordered.map((s) => ({ sceneId: s.id, title: s.title, chapterId: s.chapterId, chapterTitle: chapters.get(s.chapterId)?.title ?? null })),
        truncated: links.length > BEAT_SCENES_MAX,
    };
}

