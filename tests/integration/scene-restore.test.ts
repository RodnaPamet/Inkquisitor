/**
 * Restorable scenes (Phase 5.H-a, issue #71), against a real database:
 *
 *   - a deleted scene goes to its manuscript's Recently deleted for 30 days and comes back WHOLE: its text, note,
 *     card, element and beat links, every version, and its research proposals (owner: proposals follow the scene);
 *   - back at its place, or at the end of its chapter when a live scene took that place;
 *   - while deleted it is hidden from every list and read: the outline, the editor, the beat's scenes and the plot
 *     board's cards, word search, the research run's review, the draft reading's due scenes, the interview list;
 *   - after 30 days (the database's clock) the daily purge deletes it for good, its versions, notes, card versions
 *     and proposals with it; the database refuses any earlier hard delete, whoever asks, and a deleted chapter's
 *     cascade still passes; a scene past its window cannot be restored.
 */
import { prisma } from '@/lib/db';
import { runInWorkspaceContext, runWithoutRls } from '@/lib/db/rls-middleware';
import { createBook } from '@/app-layer/usecases/books';
import { createElement } from '@/app-layer/usecases/bible-elements';
import { createChapter, createScene, deleteChapter, deleteScene, getManuscriptOutline, listDeletedScenes, restoreScene } from '@/app-layer/usecases/manuscript';
import { checkpointScene, getScene, listBeatScenes, listSceneVersions, saveSceneText, updateSceneMeta } from '@/app-layer/usecases/manuscript-scenes';
import { getSceneCard, saveSceneCard } from '@/app-layer/usecases/scene-card';
import { getStoryMap, saveStoryMap } from '@/app-layer/usecases/story-maps';
import { searchBook } from '@/app-layer/usecases/book-search';
import { createResearchBrief, dispatchResearchRun } from '@/app-layer/usecases/research-briefs';
import { executeResearchRun } from '@/app-layer/usecases/research-run';
import { getResearchRunReview } from '@/app-layer/usecases/research-pages';
import { acceptResearchProposal } from '@/app-layer/usecases/research-review';
import { purgeDeletedScenes } from '@/app-layer/usecases/scene-purge';
import { SceneDraftReadRepository } from '@/app-layer/repositories/draft-facts.repository';
import { defaultResearcher } from '@/lib/research/model-seam';
import { NotFoundError } from '@/lib/errors/types';
import { fakeAnthropic, setFakeApiKey, type FakeTurn } from '../helpers/fake-anthropic';
import { gatherEvents, MOUNTED_GATE, type FakePage } from '../helpers/research';
import { backdateSceneDeletion } from '../helpers/scene-purge';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

let undoKey: () => void;
beforeAll(() => {
    undoKey = setFakeApiKey();
});
afterAll(async () => {
    undoKey();
    await prisma.$disconnect();
});

const PAGE: FakePage = { url: 'https://maritime.example.org/fog', title: 'Signals in fog', text: 'In fog, ships fired guns or rang bells at fixed intervals, because flags and lanterns could not be seen.' };
const NOTE = 'In fog, ships fired guns or rang bells at fixed intervals.';

function researchTurns(): FakeTurn[] {
    const finding = { claim: NOTE, summary: PAGE.text, confidence: 'HIGH', citations: [{ ref: 'web.1', quote: PAGE.text }] };
    const fit = { proposals: [{ op: 'SCENE_NOTE', elementId: null, fieldKey: null, value: NOTE, newKind: null, newName: null, newSummary: null, rationale: 'The scene is set in fog.', cites: ['f1'], sceneRef: 's2' }], noFit: [] };
    return [
        { kind: 'events', events: gatherEvents({ query: 'how ships signalled in fog', pages: [PAGE] }) },
        { kind: 'respond', answer: () => ({ kind: 'text', text: JSON.stringify({ findings: [finding] }) }) },
        { kind: 'respond', answer: () => ({ kind: 'text', text: JSON.stringify(fit) }) },
    ];
}

/** A scene holding everything a scene can: text and versions, a note from an accepted research proposal, a card, links. */
async function fullScene() {
    const ctx = workspaceCtx(await createAccount());
    const bookId = (await createBook(ctx, { title: 'The Cape' })).id;
    const mara = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Mara Quell' });
    const beat = await createElement(ctx, bookId, { kind: 'PLOT_BEAT', name: 'The fog' });
    const chapter = await createChapter(ctx, bookId, { title: 'Chapter three' });
    const before = (await createScene(ctx, bookId, { chapterId: chapter.id, title: 'Before' })).id;
    const sceneId = (await createScene(ctx, bookId, { chapterId: chapter.id, title: 'Fog off the cape' })).id;
    const after = (await createScene(ctx, bookId, { chapterId: chapter.id, title: 'After' })).id;
    const first = await saveSceneText(ctx, bookId, sceneId, { html: '<p>Mara stood at the rail and watched the lanterns drift through the fog.</p>', baseRevision: 0 });
    const second = await saveSceneText(ctx, bookId, sceneId, { html: '<p>Mara stood at the rail. The lanterns drifted closer through the fog.</p>', baseRevision: first.revision });
    await checkpointScene(ctx, bookId, sceneId, { revision: second.revision });
    const meta = await updateSceneMeta(ctx, bookId, sceneId, { baseRevision: second.revision, linkedElementIds: [mara.id], beatElementIds: [beat.id] });
    await saveSceneCard(ctx, bookId, sceneId, { baseVersion: 0, goal: 'Warn the other ship.', conflict: 'Nobody can see.', outcome: null, change: null });

    const brief = await createResearchBrief(ctx, bookId, { question: 'How did ships signal to each other in fog?', purpose: 'My captain must warn another ship.', scopeElementIds: [mara.id], scopeChapterIds: [chapter.id], depth: 'QUICK' });
    const fake = fakeAnthropic(researchTurns());
    const { runId } = await dispatchResearchRun(ctx, bookId, brief.id, { gate: MOUNTED_GATE, enqueue: async () => undefined });
    await executeResearchRun({ workspaceId: ctx.workspaceId, runId }, { gate: MOUNTED_GATE, researcher: (c) => defaultResearcher(c, { fetch: fake.fetch }) });
    const proposal = (await getResearchRunReview(ctx, bookId, runId)).sceneNotes[0];
    await acceptResearchProposal(ctx, bookId, proposal.id, {});

    // The plot board draws the beat, so its cards can be read.
    const empty = await getStoryMap(ctx, bookId, 'plot');
    await saveStoryMap(ctx, bookId, 'plot', { expectedVersion: empty.version, nodes: [{ elementId: beat.id, x: 0, y: 0, w: 200, h: 88, lane: null }], edges: [], freeform: [] });
    return { ctx, bookId, chapterId: chapter.id, sceneId, before, after, maraId: mara.id, beatId: beat.id, runId, proposalId: proposal.id, revision: meta.revision };
}

const sceneIdsOf = (outline: Awaited<ReturnType<typeof getManuscriptOutline>>) => outline.parts.flatMap((p) => p.chapters.flatMap((c) => c.scenes.map((s) => s.id)));

describe('a deleted scene comes back whole', () => {
    it('restores its text, note, card, links, history and research proposals, at its place; hidden everywhere meanwhile', async () => {
        const f = await fullScene();
        const scene = await getScene(f.ctx, f.bookId, f.sceneId);
        const card = await getSceneCard(f.ctx, f.bookId, f.sceneId);
        const versions = await listSceneVersions(f.ctx, f.bookId, f.sceneId);
        expect(versions.versions.length).toBeGreaterThanOrEqual(2);
        expect((await getResearchRunReview(f.ctx, f.bookId, f.runId)).sceneNotes.map((p) => p.id)).toEqual([f.proposalId]);
        expect((await searchBook(f.ctx, f.bookId, { q: 'lanterns' })).hits.map((h) => h.sceneId)).toContain(f.sceneId);

        await deleteScene(f.ctx, f.bookId, f.sceneId);

        // HIDDEN from every list and read.
        expect(sceneIdsOf(await getManuscriptOutline(f.ctx, f.bookId))).toEqual([f.before, f.after]);
        await expect(getScene(f.ctx, f.bookId, f.sceneId)).rejects.toBeInstanceOf(NotFoundError);
        await expect(getSceneCard(f.ctx, f.bookId, f.sceneId)).rejects.toBeInstanceOf(NotFoundError);
        expect((await listBeatScenes(f.ctx, f.bookId, f.beatId)).scenes).toEqual([]);
        expect((await getStoryMap(f.ctx, f.bookId, 'plot')).beatScenes.flatMap((b) => b.scenes.map((s) => s.sceneId))).not.toContain(f.sceneId);
        expect((await getStoryMap(f.ctx, f.bookId, 'plot')).beatScenes.find((b) => b.beatElementId === f.beatId)?.total ?? 0).toBe(0);
        const search = await searchBook(f.ctx, f.bookId, { q: 'lanterns' });
        expect(search.hits.map((h) => h.sceneId)).not.toContain(f.sceneId);
        expect(search.coverage.scenes).toBe(2);
        expect((await getResearchRunReview(f.ctx, f.bookId, f.runId)).sceneNotes).toEqual([]);
        const due = await runInWorkspaceContext(f.ctx, (db) => SceneDraftReadRepository.dueScenes(db, f.ctx.workspaceId, f.bookId, 100));
        expect(due.map((d) => d.sceneId)).not.toContain(f.sceneId);
        await expect(saveSceneText(f.ctx, f.bookId, f.sceneId, { html: '<p>x</p>', baseRevision: f.revision })).rejects.toBeInstanceOf(NotFoundError);
        // ... and listed in Recently deleted, by the database's clock.
        const listed = await listDeletedScenes(f.ctx, f.bookId);
        expect(listed.scenes.map((s) => s.id)).toEqual([f.sceneId]);
        const [{ skew }] = await prisma.$queryRaw<Array<{ skew: number }>>`SELECT abs(extract(epoch FROM ("deletedAt" - (now() AT TIME ZONE 'UTC'))))::float AS "skew" FROM "ManuscriptScene" WHERE "id" = ${f.sceneId}`;
        expect(skew).toBeLessThan(60);
        expect((await getManuscriptOutline(f.ctx, f.bookId)).totals.recentlyDeleted).toBe(1);

        const restored = await restoreScene(f.ctx, f.bookId, f.sceneId);
        expect(restored.placement).toBe('ORIGINAL');
        expect(sceneIdsOf(restored.outline)).toEqual([f.before, f.sceneId, f.after]);
        expect(await getScene(f.ctx, f.bookId, f.sceneId)).toEqual(scene);
        expect(await getSceneCard(f.ctx, f.bookId, f.sceneId)).toEqual(card);
        expect(await listSceneVersions(f.ctx, f.bookId, f.sceneId)).toEqual(versions);
        expect((await getResearchRunReview(f.ctx, f.bookId, f.runId)).sceneNotes.map((p) => p.id)).toEqual([f.proposalId]);
        expect((await listBeatScenes(f.ctx, f.bookId, f.beatId)).scenes.map((s) => s.sceneId)).toEqual([f.sceneId]);
        expect((await searchBook(f.ctx, f.bookId, { q: 'lanterns' })).hits.map((h) => h.sceneId)).toContain(f.sceneId);
        expect((await listDeletedScenes(f.ctx, f.bookId)).scenes).toEqual([]);
        const audit = await prisma.auditLog.findMany({ where: { workspaceId: f.ctx.workspaceId, entityId: f.sceneId }, select: { action: true } });
        expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['MANUSCRIPT_SCENE_DELETED', 'MANUSCRIPT_SCENE_UNDELETED']));
    });

    it('goes to the end of its chapter when a live scene has taken its place', async () => {
        const ctx = workspaceCtx(await createAccount());
        const bookId = (await createBook(ctx, { title: 'Places' })).id;
        const chapter = await createChapter(ctx, bookId, { title: 'One' });
        const a = (await createScene(ctx, bookId, { chapterId: chapter.id, title: 'A' })).id;
        const x = (await createScene(ctx, bookId, { chapterId: chapter.id, title: 'X' })).id;
        await deleteScene(ctx, bookId, x);
        // The new last scene takes the rank X held (placed after A, as X was).
        const y = (await createScene(ctx, bookId, { chapterId: chapter.id, title: 'Y' })).id;
        const ranks = await prisma.manuscriptScene.findMany({ where: { id: { in: [x, y] } }, select: { id: true, rank: true } });
        expect(new Set(ranks.map((r) => r.rank)).size).toBe(1);
        const restored = await restoreScene(ctx, bookId, x);
        expect(restored.placement).toBe('END_OF_CHAPTER');
        expect(sceneIdsOf(restored.outline)).toEqual([a, y, x]);
    });
});

describe('the 30-day window and the purge', () => {
    it('refuses any hard delete before the purge is due, whoever asks; a deleted chapter’s cascade still passes', async () => {
        const ctx = workspaceCtx(await createAccount());
        const bookId = (await createBook(ctx, { title: 'Guard' })).id;
        const chapter = await createChapter(ctx, bookId, { title: 'One' });
        const live = (await createScene(ctx, bookId, { chapterId: chapter.id, title: 'Live' })).id;
        const gone = (await createScene(ctx, bookId, { chapterId: chapter.id, title: 'Gone' })).id;
        await deleteScene(ctx, bookId, gone);
        // The superuser and app_user alike.
        await expect(prisma.manuscriptScene.delete({ where: { id: live } })).rejects.toThrow(/SCENE_DELETE_NOT_DUE/);
        await expect(prisma.manuscriptScene.delete({ where: { id: gone } })).rejects.toThrow(/SCENE_DELETE_NOT_DUE/);
        await expect(runInWorkspaceContext(ctx, (db) => db.manuscriptScene.deleteMany({ where: { id: gone } }))).rejects.toThrow(/SCENE_DELETE_NOT_DUE/);
        // The chapter's deletion names its recently deleted scene in what the author confirms, then takes it for good.
        await expect(deleteChapter(ctx, bookId, chapter.id, 1)).rejects.toMatchObject({ details: { reason: 'NOT_EMPTY', scenes: 2, recentlyDeleted: 1 } });
        await deleteChapter(ctx, bookId, chapter.id, 2);
        expect(await prisma.manuscriptScene.count({ where: { id: { in: [live, gone] } } })).toBe(0);
    });

    it('cannot restore a scene past its window, and the purge then deletes it with its history and proposals', async () => {
        const f = await fullScene();
        await deleteScene(f.ctx, f.bookId, f.sceneId);
        // Not yet due: the purge leaves it.
        await purgeDeletedScenes();
        expect(await prisma.manuscriptScene.count({ where: { id: f.sceneId } })).toBe(1);

        await backdateSceneDeletion(f.sceneId, 31);
        await expect(restoreScene(f.ctx, f.bookId, f.sceneId)).rejects.toBeInstanceOf(NotFoundError);
        expect((await listDeletedScenes(f.ctx, f.bookId)).scenes).toEqual([]);

        const result = await purgeDeletedScenes();
        expect(result).toMatchObject({ failed: 0 });
        expect(result.purged).toBeGreaterThanOrEqual(1);
        expect(result.failed).toBe(0);
        const left = await runWithoutRls({ reason: 'test' }, async (db) => ({
            scene: await db.manuscriptScene.count({ where: { id: f.sceneId } }),
            versions: await db.sceneVersion.count({ where: { sceneId: f.sceneId } }),
            notes: await db.sceneNoteVersion.count({ where: { sceneId: f.sceneId } }),
            cardVersions: await db.sceneCardVersion.count({ where: { sceneId: f.sceneId } }),
            card: await db.sceneCard.count({ where: { sceneId: f.sceneId } }),
            links: await db.sceneElementLink.count({ where: { sceneId: f.sceneId } }),
            beats: await db.sceneBeatLink.count({ where: { sceneId: f.sceneId } }),
            proposals: await db.researchProposal.count({ where: { id: f.proposalId } }),
        }));
        expect(left).toEqual({ scene: 0, versions: 0, notes: 0, cardVersions: 0, card: 0, links: 0, beats: 0, proposals: 0 });
        // The other scenes and the book's other history stand; the purge is on the record (ids and counts).
        expect(sceneIdsOf(await getManuscriptOutline(f.ctx, f.bookId))).toEqual([f.before, f.after]);
        const purged = await prisma.auditLog.findFirst({ where: { workspaceId: f.ctx.workspaceId, action: 'MANUSCRIPT_SCENE_PURGED', entityId: f.sceneId }, select: { detailsJson: true } });
        expect(purged?.detailsJson).toMatchObject({ bookId: f.bookId, versionCount: expect.any(Number), noteVersionCount: expect.any(Number), cardVersionCount: expect.any(Number) });
    });

    it('the history trigger refuses deleting a standing scene’s versions even with the purge’s marker', async () => {
        const ctx = workspaceCtx(await createAccount());
        const bookId = (await createBook(ctx, { title: 'Marker' })).id;
        const chapter = await createChapter(ctx, bookId, { title: 'One' });
        const sceneId = (await createScene(ctx, bookId, { chapterId: chapter.id, title: 'Live' })).id;
        await saveSceneText(ctx, bookId, sceneId, { html: '<p>Kept.</p>', baseRevision: 0 });
        await expect(
            prisma.$transaction(async (tx) => {
                await tx.$executeRaw`SELECT set_config('inkquisitor.scene_purge', ${sceneId}, true)`;
                await tx.sceneVersion.deleteMany({ where: { sceneId } });
            }),
        ).rejects.toThrow(/SCENE_VERSION_APPEND_ONLY/);
    });
});
