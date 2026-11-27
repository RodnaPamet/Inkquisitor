/**
 * A manuscript with a row in every one of its tables (Phase 5.1), written through the real usecases: a part (titled),
 * a chapter, a scene (title, text mentioning a character, POV, setting, story time, a plot beat, a note), its first
 * version and its first note version. `mark` is carried in every author-text column, for suites that read storage.
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { createElement } from '@/app-layer/usecases/bible-elements';
import { createChapter, createScene, getManuscriptOutline, renamePart } from '@/app-layer/usecases/manuscript';
import { saveSceneNote, saveSceneText, updateSceneMeta } from '@/app-layer/usecases/manuscript-scenes';

export interface SeededManuscript {
    manuscriptId: string;
    partId: string;
    chapterId: string;
    sceneId: string;
    characterId: string;
    settingId: string;
    beatId: string;
}

export async function seedManuscript(ctx: WorkspaceRequestContext, bookId: string, mark: string): Promise<SeededManuscript> {
    const character = await createElement(ctx, bookId, { kind: 'CHARACTER', name: `Wren ${mark}` });
    const setting = await createElement(ctx, bookId, { kind: 'SETTING', name: `The quay ${mark}` });
    const beat = await createElement(ctx, bookId, { kind: 'PLOT_BEAT', name: `The crossing ${mark}` });
    const chapter = await createChapter(ctx, bookId, { title: `Chapter ${mark}` });
    const outline = await getManuscriptOutline(ctx, bookId);
    const partId = outline.parts[0].id;
    await renamePart(ctx, bookId, partId, { title: `Part ${mark}` });
    const scene = await createScene(ctx, bookId, { chapterId: chapter.id, title: `Scene ${mark}` });
    const html = `<p>The ferry ${mark} crossed with <span data-mention="${character.id}">@Wren</span> aboard.</p>`;
    const saved = await saveSceneText(ctx, bookId, scene.id, { html, baseRevision: 0, checkpoint: true });
    if (saved.versionNumber !== 1) throw new Error('the manuscript fixture wrote no version');
    await updateSceneMeta(ctx, bookId, scene.id, {
        baseRevision: saved.revision,
        povElementId: character.id,
        settingElementId: setting.id,
        storyTime: `Dawn ${mark}`,
        beatElementIds: [beat.id],
    });
    await saveSceneNote(ctx, bookId, scene.id, { note: `Note ${mark}`, baseNoteVersion: 0 });
    const manuscriptId = (await getManuscriptOutline(ctx, bookId)).manuscriptId;
    if (!manuscriptId) throw new Error('the manuscript fixture has no manuscript');
    return { manuscriptId, partId, chapterId: chapter.id, sceneId: scene.id, characterId: character.id, settingId: setting.id, beatId: beat.id };
}

/**
 * The prose checks' rows (Phase 5.2, D34), through the real usecases: the book's settings, a scene's check and its
 * findings (run by the job's own usecase), the book's word baseline, and a dismissal.
 */
export async function seedProseChecks(ctx: WorkspaceRequestContext, bookId: string, chapterId: string, mark: string): Promise<{ sceneId: string }> {
    const { executeProseCheck } = await import('@/app-layer/usecases/prose-check-run');
    const { dismissProseFinding, getSceneProseChecks, saveProseCheckSettings } = await import('@/app-layer/usecases/prose-checks');
    await saveProseCheckSettings(ctx, bookId, { alexEnabled: true, rulesOff: ['wordy'] });
    const scene = await createScene(ctx, bookId, { chapterId, title: `Checked ${mark}` });
    await saveSceneText(ctx, bookId, scene.id, { html: `<p>He was very tired. The the ferry ${mark} waited.</p>`, baseRevision: 0 }, { enqueueProseCheck: async () => undefined });
    const run = await executeProseCheck({ workspaceId: ctx.workspaceId, sceneId: scene.id });
    if (run.outcome !== 'CHECKED' || run.findings < 2) throw new Error('the prose-check fixture found nothing');
    const view = await getSceneProseChecks(ctx, bookId, scene.id);
    await dismissProseFinding(ctx, bookId, { findingId: view.findings[0].id });
    return { sceneId: scene.id };
}
