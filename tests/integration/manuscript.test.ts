/**
 * The manuscript (Phase 5.1, D33), against a real database:
 *
 *   - structure: a chapter with no part goes into one untitled part (shown as no part level); order by rank; a stale
 *     neighbour is 409 ORDER_STALE; a part or chapter holding scenes is deleted only when the count is confirmed;
 *   - the text: an autosave stores sanitised prose, counts its words, moves the revision, and derives the links from
 *     its mentions (only of elements of the book; another book's id is plain text); a stale base is 409 VERSION_CONFLICT
 *     and writes nothing;
 *   - versions (owner decision 1): a version at the first save, then only at a checkpoint or past the server's bound —
 *     never on every autosave; a restore is a new save and a new version; the history is append-only;
 *   - details: POV a CHARACTER, setting a SETTING, beats PLOT_BEATs of the book (400 WRONG_KIND / UNKNOWN_ELEMENT);
 *     a beat lists its scenes (owner decision 2); deleting the character sets only the POV null;
 *   - encryption at rest: the text, title, note and every version are envelopes in the database;
 *   - isolation: another workspace reads none of it.
 */
import { Client } from 'pg';
import { prisma } from '@/lib/db';
import { createElement, deleteElement } from '@/app-layer/usecases/bible-elements';
import { createBook } from '@/app-layer/usecases/books';
import { createChapter, createPart, createScene, deleteChapter, deletePart, deleteScene, getManuscriptOutline, moveScene } from '@/app-layer/usecases/manuscript';
import {
    checkpointScene,
    getScene,
    getSceneVersion,
    listBeatScenes,
    listSceneVersions,
    restoreSceneVersion,
    saveSceneNote,
    saveSceneText,
    updateSceneMeta,
} from '@/app-layer/usecases/manuscript-scenes';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors/types';
import { getStoryMap, saveStoryMap } from '@/app-layer/usecases/story-maps';
import { BOARD_SCENES_PER_BEAT } from '@/lib/canvas/limits';
import { SCENE_VERSION_MAX_GAP_MS } from '@/lib/manuscript/vocabulary';
import { ORDER_RANK_MAX, rebalancedRanks } from '@/lib/bible/story-order';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

let ctx: ReturnType<typeof workspaceCtx>;
let bookId: string;

beforeAll(async () => {
    ctx = workspaceCtx(await createAccount());
    bookId = (await createBook(ctx, { title: 'Manuscript book' })).id;
});

async function newScene(title = 'A scene') {
    const chapter = await createChapter(ctx, bookId, { title: `Chapter for ${title}` });
    const scene = await createScene(ctx, bookId, { chapterId: chapter.id, title });
    return { chapterId: chapter.id, sceneId: scene.id };
}

describe('structure', () => {
    it('puts a chapter with no part into one untitled part, which the outline shows as no part level', async () => {
        const fresh = (await createBook(ctx, { title: 'Fresh' })).id;
        expect((await getManuscriptOutline(ctx, fresh)).manuscriptId).toBeNull();
        const a = await createChapter(ctx, fresh, { title: 'One' });
        const b = await createChapter(ctx, fresh, { title: 'Zero', before: a.id });
        const outline = b.outline;
        expect(outline.singleDefaultPart).toBe(true);
        expect(outline.parts).toHaveLength(1);
        expect(outline.parts[0].chapters.map((c) => c.title)).toEqual(['Zero', 'One']);
        await createPart(ctx, fresh, { title: 'Book Two' });
        expect((await getManuscriptOutline(ctx, fresh)).singleDefaultPart).toBe(false);
    });

    it('refuses a neighbour that is not there (409 ORDER_STALE) and moves a scene between two others', async () => {
        const { chapterId, sceneId: first } = await newScene('Order one');
        const last = (await createScene(ctx, bookId, { chapterId, title: 'Order three' })).id;
        const middle = (await createScene(ctx, bookId, { chapterId, title: 'Order two' })).id;
        await expect(createScene(ctx, bookId, { chapterId, after: 'gone' })).rejects.toMatchObject({ details: { reason: 'ORDER_STALE' } });
        const outline = await moveScene(ctx, bookId, middle, { chapterId, after: first, before: last });
        const chapter = outline.parts.flatMap((p) => p.chapters).find((c) => c.id === chapterId)!;
        expect(chapter.scenes.map((s) => s.title)).toEqual(['Order one', 'Order two', 'Order three']);
    });

    it('a spent rank gap rebalances the parent in place and the scene lands where it was asked; nothing else moves', async () => {
        const { chapterId, sceneId: a } = await newScene('Gap A');
        const b = (await createScene(ctx, bookId, { chapterId, title: 'Gap B' })).id;
        const c = (await createScene(ctx, bookId, { chapterId, title: 'Gap C' })).id;
        // A and B a 64-character key apart, as about three hundred inserts at one spot (or swaps of two neighbours) leave them.
        await prisma.manuscriptScene.update({ where: { id: a }, data: { rank: 'i' } });
        await prisma.manuscriptScene.update({ where: { id: b }, data: { rank: `i${'0'.repeat(ORDER_RANK_MAX - 2)}1` } });
        await prisma.manuscriptScene.update({ where: { id: c }, data: { rank: 'r' } });
        const revisions = await prisma.manuscriptScene.findMany({ where: { chapterId }, select: { id: true, revision: true } });
        const titles = (o: Awaited<ReturnType<typeof getManuscriptOutline>>) => o.parts.flatMap((p) => p.chapters).find((ch) => ch.id === chapterId)!.scenes.map((sc) => sc.title);

        const created = await createScene(ctx, bookId, { chapterId, title: 'Gap new', after: a, before: b });
        expect(titles(created.outline)).toEqual(['Gap A', 'Gap new', 'Gap B', 'Gap C']);
        const ranks = await prisma.manuscriptScene.findMany({ where: { id: { in: [a, b, c] } }, select: { rank: true } });
        expect(new Set(ranks.map((r) => r.rank))).toEqual(new Set(rebalancedRanks(3)));
        expect(await prisma.auditLog.count({ where: { workspaceId: ctx.workspaceId, action: 'MANUSCRIPT_ORDER_REBALANCED', detailsJson: { path: ['parentId'], equals: chapterId } } })).toBe(1);
        // No scene's text, revision or history moved: a rebalance changes keys, not the book.
        const after = await prisma.manuscriptScene.findMany({ where: { id: { in: [a, b, c] } }, select: { id: true, revision: true } });
        expect(after.sort((x, y) => x.id.localeCompare(y.id))).toEqual(revisions.sort((x, y) => x.id.localeCompare(y.id)));

        // A move into a spent gap rebalances too (C between A and the new scene, once that gap is spent).
        const fresh = await prisma.manuscriptScene.findMany({ where: { chapterId }, select: { id: true, rank: true } });
        const newId = created.id;
        const rankOfA = fresh.find((r) => r.id === a)!.rank;
        await prisma.manuscriptScene.update({ where: { id: newId }, data: { rank: `${rankOfA}${'0'.repeat(ORDER_RANK_MAX - rankOfA.length - 1)}1` } });
        const moved = await moveScene(ctx, bookId, c, { chapterId, after: a, before: newId });
        expect(titles(moved)).toEqual(['Gap A', 'Gap C', 'Gap new', 'Gap B']);
        expect(await prisma.auditLog.count({ where: { workspaceId: ctx.workspaceId, action: 'MANUSCRIPT_ORDER_REBALANCED', detailsJson: { path: ['parentId'], equals: chapterId } } })).toBe(2);
    });

    it('deletes a chapter holding scenes only when the count is confirmed', async () => {
        const { chapterId } = await newScene('Doomed');
        await expect(deleteChapter(ctx, bookId, chapterId)).rejects.toMatchObject({ details: { reason: 'NOT_EMPTY', scenes: 1 } });
        await expect(deleteChapter(ctx, bookId, chapterId, 2)).rejects.toBeInstanceOf(ConflictError);
        await deleteChapter(ctx, bookId, chapterId, 1);
        expect(await prisma.manuscriptChapter.count({ where: { id: chapterId } })).toBe(0);
    });

    it('deletes an empty part at once', async () => {
        const part = await createPart(ctx, bookId, { title: 'Empty part' });
        await deletePart(ctx, bookId, part.id);
        expect(await prisma.manuscriptPart.count({ where: { id: part.id } })).toBe(0);
    });
});

describe('the text', () => {
    it('stores sanitised prose, counts words, moves the revision, and derives links from mentions of the book only', async () => {
        const { sceneId } = await newScene('Text');
        const wren = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Wren', summary: 'A diver.' });
        const other = (await createBook(ctx, { title: 'Other book' })).id;
        const stranger = await createElement(ctx, other, { kind: 'CHARACTER', name: 'Stranger' });
        const html = `<p onclick="x()">She met <span data-mention="${wren.id}">@Wren</span> and <span data-mention="${stranger.id}">@Stranger</span>.</p><script>alert(1)</script><h1>Not a heading</h1>`;
        const saved = await saveSceneText(ctx, bookId, sceneId, { html, baseRevision: 0 });
        expect(saved.revision).toBe(1);
        expect(saved.wordCount).toBe(8);
        const scene = await getScene(ctx, bookId, sceneId);
        expect(scene.text).toBe(`<p>She met <span data-mention="${wren.id}">@Wren</span> and <span>@Stranger</span>.</p>Not a heading`);
        expect(scene.links).toEqual([{ elementId: wren.id, kind: 'CHARACTER', name: 'Wren', summary: 'A diver.', mentioned: true, explicit: false }]);

        // A save naming an old revision writes nothing.
        await expect(saveSceneText(ctx, bookId, sceneId, { html: '<p>Lost</p>', baseRevision: 0 })).rejects.toMatchObject({ details: { reason: 'VERSION_CONFLICT', currentRevision: 1 } });
        expect((await getScene(ctx, bookId, sceneId)).text).toContain('She met');

        // The mention removed: its link goes (it was never explicit).
        await saveSceneText(ctx, bookId, sceneId, { html: '<p>Alone.</p>', baseRevision: 1 });
        expect((await getScene(ctx, bookId, sceneId)).links).toEqual([]);
    });
});

describe('versions (D33: at a checkpoint, never on every autosave)', () => {
    it('writes a version on the first save, then only at a checkpoint or past the bound', async () => {
        const { sceneId } = await newScene('Versions');
        const count = () => prisma.sceneVersion.count({ where: { sceneId } });
        let rev = 0;
        const save = async (html: string, checkpoint = false, now?: Date) => {
            const r = await saveSceneText(ctx, bookId, sceneId, { html, baseRevision: rev, checkpoint }, now ? { now } : {});
            rev = r.revision;
            return r;
        };
        expect((await save('<p>One</p>')).versionNumber).toBe(1);
        for (let i = 0; i < 5; i++) expect((await save(`<p>One and ${i}</p>`)).versionNumber).toBeNull();
        expect(await count()).toBe(1);
        // A checkpoint (the author paused, or left) writes one.
        expect((await save('<p>One and more</p>', true)).versionNumber).toBe(2);
        // A checkpoint over text equal to the newest version writes none.
        expect((await save('<p>One and more</p>', true)).versionNumber).toBeNull();
        // Inside the server's bound (thirty minutes, D33 item C) a plain autosave writes none, even twenty minutes on.
        expect(SCENE_VERSION_MAX_GAP_MS).toBe(30 * 60_000);
        expect((await save('<p>Twenty minutes on</p>', false, new Date(Date.now() + 20 * 60_000))).versionNumber).toBeNull();
        // Past the server's bound a plain autosave writes one: a lost checkpoint still bounds the gap.
        const later = new Date(Date.now() + SCENE_VERSION_MAX_GAP_MS + 60_000);
        expect((await save('<p>Much later</p>', false, later)).versionNumber).toBe(3);
        // The checkpoint route versions the stored text when the tab's revision stands.
        await save('<p>Typed then left</p>');
        expect((await checkpointScene(ctx, bookId, sceneId, { revision: rev - 1 })).versionNumber).toBeNull();
        expect((await checkpointScene(ctx, bookId, sceneId, { revision: rev })).versionNumber).toBe(4);
        expect(await count()).toBe(4);
    });

    it('restores a version as a new save and a new version, refusing a stale base', async () => {
        const { sceneId } = await newScene('Restore');
        const a = await saveSceneText(ctx, bookId, sceneId, { html: '<p>First draft</p>', baseRevision: 0 });
        const b = await saveSceneText(ctx, bookId, sceneId, { html: '<p>Second draft</p>', baseRevision: a.revision, checkpoint: true });
        await expect(restoreSceneVersion(ctx, bookId, sceneId, 1, { baseRevision: a.revision })).rejects.toMatchObject({ details: { reason: 'VERSION_CONFLICT' } });
        const restored = await restoreSceneVersion(ctx, bookId, sceneId, 1, { baseRevision: b.revision });
        expect(restored.versionNumber).toBe(3);
        expect((await getScene(ctx, bookId, sceneId)).text).toBe('<p>First draft</p>');
        const page = await listSceneVersions(ctx, bookId, sceneId);
        expect(page.versions.map((v) => [v.versionNumber, v.source, v.restoredFromVersion])).toEqual([
            [3, 'RESTORE', 1],
            [2, 'EDIT', null],
            [1, 'EDIT', null],
        ]);
        expect((await getSceneVersion(ctx, bookId, sceneId, 2)).text).toBe('<p>Second draft</p>');
        // Append-only, whoever writes.
        await expect(prisma.sceneVersion.updateMany({ where: { sceneId }, data: { wordCount: 99 } })).rejects.toThrow(/SCENE_VERSION_APPEND_ONLY/);
        await expect(prisma.sceneVersion.deleteMany({ where: { sceneId } })).rejects.toThrow(/SCENE_VERSION_APPEND_ONLY/);
    });

    it('keeps a deleted scene\'s history with the book', async () => {
        const { sceneId } = await newScene('Deleted');
        await saveSceneText(ctx, bookId, sceneId, { html: '<p>Words</p>', baseRevision: 0 });
        await deleteScene(ctx, bookId, sceneId);
        await expect(getScene(ctx, bookId, sceneId)).rejects.toBeInstanceOf(NotFoundError);
        expect(await prisma.sceneVersion.count({ where: { sceneId } })).toBe(1);
    });
});

describe('details', () => {
    it('holds POV, setting and beats to their kinds and the book; a beat lists its scenes; a deleted POV clears only the POV', async () => {
        const { sceneId } = await newScene('Details');
        const char = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Ada' });
        const place = await createElement(ctx, bookId, { kind: 'SETTING', name: 'The Quay' });
        const beat = await createElement(ctx, bookId, { kind: 'PLOT_BEAT', name: 'The storm' });
        const theme = await createElement(ctx, bookId, { kind: 'THEME', name: 'Debt' });
        await expect(updateSceneMeta(ctx, bookId, sceneId, { baseRevision: 0, povElementId: place.id })).rejects.toMatchObject({ details: { reason: 'WRONG_KIND', field: 'povElementId' } });
        await expect(updateSceneMeta(ctx, bookId, sceneId, { baseRevision: 0, beatElementIds: ['nope'] })).rejects.toBeInstanceOf(ValidationError);
        const scene = await updateSceneMeta(ctx, bookId, sceneId, {
            baseRevision: 0,
            title: '<b>Arrival</b>',
            povElementId: char.id,
            settingElementId: place.id,
            storyTime: 'Dawn, day 2',
            linkedElementIds: [theme.id],
            beatElementIds: [beat.id],
        });
        expect(scene.title).toBe('Arrival');
        expect(scene.pov).toEqual({ id: char.id, name: 'Ada' });
        expect(scene.setting).toEqual({ id: place.id, name: 'The Quay' });
        expect(scene.links.map((l) => [l.name, l.explicit, l.mentioned])).toEqual([['Debt', true, false]]);
        expect(scene.beats).toEqual([{ id: beat.id, name: 'The storm' }]);
        expect((await listBeatScenes(ctx, bookId, beat.id)).scenes.map((s) => s.sceneId)).toEqual([sceneId]);

        await deleteElement(ctx, bookId, char.id);
        const after = await getScene(ctx, bookId, sceneId);
        expect(after.pov).toBeNull();
        expect(after.setting).toEqual({ id: place.id, name: 'The Quay' });
        expect(after.revision).toBe(1);
    });

    it('the database holds the kinds whoever writes: a THEME as POV or setting, or a CHARACTER as a beat, is refused', async () => {
        const { sceneId } = await newScene('Kinds in the database');
        const theme = await createElement(ctx, bookId, { kind: 'THEME', name: 'Salt' });
        const char = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Ines' });
        // As the owner, past every usecase: the triggers are what refuse.
        await expect(prisma.manuscriptScene.update({ where: { id: sceneId }, data: { povElementId: theme.id } })).rejects.toThrow(/SCENE_ELEMENT_KIND/);
        await expect(prisma.manuscriptScene.update({ where: { id: sceneId }, data: { settingElementId: char.id } })).rejects.toThrow(/SCENE_ELEMENT_KIND/);
        await expect(prisma.sceneBeatLink.create({ data: { workspaceId: ctx.workspaceId, bookId, sceneId, beatElementId: char.id } })).rejects.toThrow(/SCENE_ELEMENT_KIND/);
        expect(await prisma.manuscriptScene.findUniqueOrThrow({ where: { id: sceneId }, select: { povElementId: true, settingElementId: true } })).toEqual({ povElementId: null, settingElementId: null });
        expect(await prisma.sceneBeatLink.count({ where: { sceneId } })).toBe(0);
        await expect(prisma.manuscriptScene.update({ where: { id: sceneId }, data: { povElementId: char.id } })).resolves.toMatchObject({ povElementId: char.id });
    });

    it('saves the note under its own counter, one MANUAL note version a change', async () => {
        const { sceneId } = await newScene('Note');
        const a = await saveSceneNote(ctx, bookId, sceneId, { note: 'Check the tide tables.', baseNoteVersion: 0 });
        expect(a.noteVersion).toBe(1);
        await expect(saveSceneNote(ctx, bookId, sceneId, { note: 'x', baseNoteVersion: 0 })).rejects.toMatchObject({ details: { reason: 'VERSION_CONFLICT' } });
        expect(await prisma.sceneNoteVersion.count({ where: { sceneId, source: 'MANUAL' } })).toBe(1);
    });
});

describe('the plot board\'s scene cards (D33 addendum B)', () => {
    it('the board\'s view carries each beat\'s scenes in manuscript order as display data, and a save of the shown board writes the same rows', async () => {
        const fresh = (await createBook(ctx, { title: 'Board' })).id;
        const beat = await createElement(ctx, fresh, { kind: 'PLOT_BEAT', name: 'The storm' });
        const quiet = await createElement(ctx, fresh, { kind: 'PLOT_BEAT', name: 'The calm' });
        const one = await createChapter(ctx, fresh, { title: 'One' });
        const two = await createChapter(ctx, fresh, { title: 'Two' });
        // Created out of order: the cards follow the manuscript (chapter, then scene), not the links.
        const late = (await createScene(ctx, fresh, { chapterId: two.id, title: 'Late' })).id;
        const first = (await createScene(ctx, fresh, { chapterId: one.id, title: 'First' })).id;
        const second = (await createScene(ctx, fresh, { chapterId: one.id, title: 'Second' })).id;
        for (const id of [late, first, second]) await updateSceneMeta(ctx, fresh, id, { baseRevision: 0, beatElementIds: [beat.id] });

        const empty = await getStoryMap(ctx, fresh, 'plot');
        const saved = await saveStoryMap(ctx, fresh, 'plot', {
            expectedVersion: empty.version,
            nodes: [beat.id, quiet.id].map((elementId) => ({ elementId, x: 0, y: 0, w: 200, h: 88, lane: null })),
            edges: [],
            freeform: [],
        });
        const view = saved.map;
        expect(view.beatScenes).toEqual([
            {
                beatElementId: beat.id,
                total: 3,
                scenes: [
                    { sceneId: first, title: 'First', chapterTitle: 'One' },
                    { sceneId: second, title: 'Second', chapterTitle: 'One' },
                ].slice(0, BOARD_SCENES_PER_BEAT),
            },
        ]);
        // A save of exactly what the board shows (its rows; the cards are not rows) writes nothing new.
        const again = await saveStoryMap(ctx, fresh, 'plot', {
            expectedVersion: view.version,
            nodes: view.nodes.map((n) => ({ elementId: n.elementId, x: n.x, y: n.y, w: n.w, h: n.h, lane: n.lane })),
            edges: [],
            freeform: [],
        });
        expect(again.saved).toBe(false);
        expect(again.map.version).toBe(view.version);
        const stored = await prisma.mapSnapshot.findMany({ where: { mapId: (await prisma.storyMap.findFirstOrThrow({ where: { bookId: fresh, kind: 'PLOT' } })).id } });
        expect(stored.map((snap) => snap.version)).toEqual([view.version]);
        // The other maps carry none.
        expect((await getStoryMap(ctx, fresh, 'relationship')).beatScenes).toEqual([]);
    });
});

describe('lock order', () => {
    /** Until a backend waits on a row lock of a scene (the save, behind the deletion's hold). */
    async function waitForSceneRowWait(): Promise<void> {
        for (let i = 0; i < 400; i++) {
            const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
                SELECT count(*) AS n FROM pg_stat_activity
                 WHERE wait_event_type = 'Lock' AND datname = current_database() AND query LIKE '%"ManuscriptScene"%'`;
            if (Number(rows[0].n) > 0) return;
            await new Promise((r) => setTimeout(r, 25));
        }
        throw new Error('the save never waited on the scene row');
    }

    it('a save takes the scene row before any link row, as a chapter deletion does (no deadlock between them)', async () => {
        const { sceneId } = await newScene('Lock order');
        const gull = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Gull' });
        const first = await saveSceneText(ctx, bookId, sceneId, { html: `<p>Hello <span data-mention="${gull.id}">@Gull</span>.</p>`, baseRevision: 0 });
        expect(await prisma.sceneElementLink.count({ where: { sceneId } })).toBe(1);

        // A chapter deletion's cascade holds the scene row first (here, as the owner, a row lock like the cascade's).
        const deleter = new Client({ connectionString: process.env.DATABASE_URL });
        const probe = new Client({ connectionString: process.env.DATABASE_URL });
        await deleter.connect();
        await probe.connect();
        let saving: Promise<{ ok: unknown } | { failed: unknown }> | null = null;
        let held: { rowCount: number | null } | Error;
        try {
            await deleter.query('BEGIN');
            await deleter.query('SELECT 1 FROM "ManuscriptScene" WHERE "id" = $1 FOR UPDATE', [sceneId]);
            // The save drops the mention, so it would delete the link row.
            saving = saveSceneText(ctx, bookId, sceneId, { html: '<p>Hello.</p>', baseRevision: first.revision }).then(
                (ok) => ({ ok }),
                (failed: unknown) => ({ failed }),
            );
            await waitForSceneRowWait();
            // The save waits on the scene row holding NO link row: the deletion's cascade could take them all.
            await probe.query('BEGIN');
            held = await probe.query('SELECT 1 FROM "SceneElementLink" WHERE "sceneId" = $1 FOR UPDATE NOWAIT', [sceneId]).catch((err: Error) => err);
            await probe.query('ROLLBACK');
        } finally {
            await deleter.query('ROLLBACK').catch(() => undefined);
            const outcome = saving ? await saving : null;
            await probe.end();
            await deleter.end();
            expect(outcome).toMatchObject({ ok: { revision: first.revision + 1 } });
        }
        expect(held).toMatchObject({ rowCount: 1 });
        expect(await prisma.sceneElementLink.count({ where: { sceneId } })).toBe(0);
    });
});

describe('encryption and isolation', () => {
    it('stores the text, title, note and versions as envelopes, and another workspace reads none of it', async () => {
        const { sceneId } = await newScene('Secret');
        await updateSceneMeta(ctx, bookId, sceneId, { baseRevision: 0, title: 'Secret title', storyTime: 'Secret time' });
        await saveSceneText(ctx, bookId, sceneId, { html: '<p>Secret prose</p>', baseRevision: 1 });
        await saveSceneNote(ctx, bookId, sceneId, { note: 'Secret note', baseNoteVersion: 0 });
        const raw = await prisma.$queryRaw<Array<{ title: string; text: string; note: string; storyTime: string }>>`SELECT "title", "text", "note", "storyTime" FROM "ManuscriptScene" WHERE "id" = ${sceneId}`;
        for (const v of Object.values(raw[0])) expect(v.startsWith('v2:')).toBe(true);
        const versions = await prisma.$queryRaw<Array<{ text: string }>>`SELECT "text" FROM "SceneVersion" WHERE "sceneId" = ${sceneId}`;
        expect(versions.every((v) => v.text.startsWith('v2:'))).toBe(true);

        const stranger = workspaceCtx(await createAccount());
        await expect(getScene(stranger, bookId, sceneId)).rejects.toBeInstanceOf(NotFoundError);
        await expect(saveSceneText(stranger, bookId, sceneId, { html: '<p>x</p>', baseRevision: 2 })).rejects.toBeInstanceOf(NotFoundError);
    });
});
