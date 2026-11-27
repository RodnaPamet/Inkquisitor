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

/**
 * The draft held against the bible's rows (Phase 5.3, D35), through the real usecases: the night's reading of the
 * seeded scene (its cursor, its run, a draft fact and a plant link proposed for a thread, with a scripted reader — no
 * model), the scene's card with its first version, and the book's continuity settings (D35 addendum A).
 */
export async function seedDraftAgainstBible(ctx: WorkspaceRequestContext, bookId: string, sceneId: string, mark: string): Promise<void> {
    const { createThread, saveContinuitySettings } = await import('@/app-layer/usecases/continuity');
    const { executeDraftReadDispatch } = await import('@/app-layer/usecases/draft-read-dispatch');
    const { executeDraftRead } = await import('@/app-layer/usecases/draft-read');
    const { saveSceneCard } = await import('@/app-layer/usecases/scene-card');
    const { setFakeApiKey } = await import('./fake-anthropic');
    await createThread(ctx, bookId, { kind: 'PROMISE', title: `The ferry ${mark} crossing`, note: null });
    const queued: string[] = [];
    await executeDraftReadDispatch({ enqueue: async (_n, payload) => void queued.push((payload as { runId: string }).runId), workspaceIds: [ctx.workspaceId], nightKey: `seed-${mark}-${Date.now().toString(36)}` });
    const quote = `The ferry ${mark} crossed`;
    const undo = setFakeApiKey();
    try {
        for (const runId of queued) {
            await executeDraftRead(
                { workspaceId: ctx.workspaceId, runId },
                {
                    charge: () => undefined,
                    gate: () => ({ mounted: true, recordKind: 'structural' }),
                    nightlyCapMicroUsd: Number.MAX_SAFE_INTEGER,
                    reader: () => ({
                        extract: async (request) => {
                            const text = request.data.find((b) => b.label === 'scene.text')?.text ?? '';
                            const hit = text.includes(quote);
                            return {
                                ok: true as const,
                                output: {
                                    facts: hit ? [{ subject: 'The ferry', predicate: 'OTHER', object: '', statement: `${quote} the water.`, quote, storyTimeFrom: '', storyTimeTo: '' }] : [],
                                    threads: hit ? [{ thread: 1, role: 'PLANTS', quote }] : [],
                                },
                                tokensUsed: 1,
                                costMicroUsd: 1,
                                callIds: [] as string[],
                            };
                        },
                    }),
                },
            );
        }
    } finally {
        undo();
    }
    await saveSceneCard(ctx, bookId, sceneId, { baseVersion: 0, goal: `Cross ${mark}`, conflict: null, outcome: null, change: null });
    // D35 addendum A: the book's continuity settings row (the deep check reads the draft).
    await saveContinuitySettings(ctx, bookId, { deepReadsDraft: true });
}

/**
 * One open draft mismatch (Phase 5.3, D35), through the real usecases: a character whose bible says green eyes (its
 * fact extracted by a scripted extractor), a scene in `chapterId` that says blue, and the night's reading with a
 * scripted reader. Returns the mismatch's id and the scene's.
 */
export async function seedDraftMismatch(ctx: WorkspaceRequestContext, bookId: string, chapterId: string, name = 'Mara'): Promise<{ mismatchId: string; sceneId: string }> {
    const { updateElementFields } = await import('@/app-layer/usecases/bible-elements');
    const { executeDraftReadDispatch } = await import('@/app-layer/usecases/draft-read-dispatch');
    const { executeDraftRead } = await import('@/app-layer/usecases/draft-read');
    const { extractPending } = await import('./facts');
    const { setFakeApiKey } = await import('./fake-anthropic');
    const { runWithoutRls } = await import('@/lib/db/rls-middleware');
    const el = await createElement(ctx, bookId, { kind: 'CHARACTER', name });
    await updateElementFields(ctx, bookId, el.id, { fields: [{ key: 'physical_presence', value: `${name} has green eyes.` }], baseVersion: el.versionNumber });
    await extractPending(ctx, bookId, () => ({
        async extract(request) {
            const text = request.data.find((b) => b.label === 'entry.text')?.text ?? '';
            const facts = text.includes(`${name} has green eyes`) ? [{ subject: name, predicate: 'APPEARANCE', object: 'green eyes', statement: `${name} has green eyes.`, quote: `${name} has green eyes`, storyTimeFrom: '', storyTimeTo: '', contradicts: [] }] : [];
            return { ok: true, output: { facts }, tokensUsed: 1, costMicroUsd: 1, callIds: [] };
        },
    }));
    const scene = await createScene(ctx, bookId, { chapterId, title: 'The lamp' });
    await saveSceneText(ctx, bookId, scene.id, { html: `<p>${name} looked up, ${name}’s blue eyes wet.</p>`, baseRevision: 0 });
    const queued: string[] = [];
    await executeDraftReadDispatch({ enqueue: async (_n, payload) => void queued.push((payload as { runId: string }).runId), workspaceIds: [ctx.workspaceId], nightKey: `mismatch-${Date.now().toString(36)}` });
    const quote = `${name}’s blue eyes`;
    const undo = setFakeApiKey();
    try {
        for (const runId of queued) {
            await executeDraftRead(
                { workspaceId: ctx.workspaceId, runId },
                {
                    charge: () => undefined,
                    gate: () => ({ mounted: true, recordKind: 'structural' }),
                    nightlyCapMicroUsd: Number.MAX_SAFE_INTEGER,
                    reader: () => ({
                        extract: async (request) => {
                            const text = request.data.find((b) => b.label === 'scene.text')?.text ?? '';
                            const facts = text.includes(quote) ? [{ subject: name, predicate: 'APPEARANCE', object: 'blue eyes', statement: `${name} has blue eyes.`, quote, storyTimeFrom: '', storyTimeTo: '' }] : [];
                            return { ok: true as const, output: { facts, threads: [] }, tokensUsed: 1, costMicroUsd: 1, callIds: [] as string[] };
                        },
                    }),
                },
            );
        }
    } finally {
        undo();
    }
    const row = await runWithoutRls({ reason: 'test' }, (db) => db.storyFactProposal.findFirstOrThrow({ where: { bookId, sceneId: scene.id, basis: 'DRAFT' }, select: { id: true } }));
    return { mismatchId: row.id, sceneId: scene.id };
}
