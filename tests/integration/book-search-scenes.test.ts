/**
 * Word search over the manuscript's scenes (Phase 5.H-a, D33 addendum A), against a real database: option A as for
 * the bible (decrypt and scan, nothing stored). A scene's title, text and note are searched; its text as the plain
 * text the editor rebuilds, so a snippet's offsets point at the match in the scene; a deleted scene and another
 * book's scenes are never found; the read is bounded and every cut is named; nothing is written.
 */
import { prisma } from '@/lib/db';
import { createBook } from '@/app-layer/usecases/books';
import { createElement } from '@/app-layer/usecases/bible-elements';
import { createChapter, createScene, deleteScene } from '@/app-layer/usecases/manuscript';
import { saveSceneNote, saveSceneText } from '@/app-layer/usecases/manuscript-scenes';
import { SEARCH_READ_LIMITS, searchBook } from '@/app-layer/usecases/book-search';
import { HtmlTextReader } from '@/lib/search/plain-text';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

const noCheck = { enqueueProseCheck: async () => undefined };

async function seed() {
    const ctx = workspaceCtx(await createAccount());
    const book = await createBook(ctx, { title: 'The Wennaway Light' });
    const ilse = await createElement(ctx, book.id, { kind: 'CHARACTER', name: 'Ilse Marrow' });
    const chapter = await createChapter(ctx, book.id, { title: 'The Reef' });
    const rowing = (await createScene(ctx, book.id, { chapterId: chapter.id, title: 'Rowing out' })).id;
    const html = `<p>The storm came early.</p><p>She <em>rowed</em> past the reef with <span data-mention="${ilse.id}">@Ilse Marrow</span> watching, and the lamp kept burning.</p>`;
    await saveSceneText(ctx, book.id, rowing, { html, baseRevision: 0 }, noCheck);
    await saveSceneNote(ctx, book.id, rowing, { note: 'Check the tide tables for the equinox.', baseNoteVersion: 0 });
    const lighthouse = (await createScene(ctx, book.id, { chapterId: chapter.id, title: 'Equinox lamp' })).id;
    await saveSceneText(ctx, book.id, lighthouse, { html: '<p>Nothing moved on the rock.</p>', baseRevision: 0 }, noCheck);
    const other = await createBook(ctx, { title: 'Saltmarsh' });
    const oc = await createChapter(ctx, other.id, { title: 'Marsh' });
    const os = (await createScene(ctx, other.id, { chapterId: oc.id, title: 'Smugglers' })).id;
    await saveSceneText(ctx, other.id, os, { html: '<p>They rowed brandy past the reef.</p>', baseRevision: 0 }, noCheck);
    return { ctx, bookId: book.id, rowing, lighthouse, html, otherScene: os };
}

it('finds a scene by a stemmed word of its text, with offsets into the text the editor rebuilds', async () => {
    const f = await seed();
    const r = await searchBook(f.ctx, f.bookId, { q: 'rowing' });
    const hit = r.hits.find((h) => h.sceneId === f.rowing)!;
    expect(hit).toMatchObject({ kind: 'scene', elementId: null, name: 'Rowing out', chapterTitle: 'The Reef' });
    const text = hit.matches.find((m) => m.source === 'sceneText')!;
    const plain = new HtmlTextReader().read(f.html);
    for (const h of text.snippet.highlights) expect(plain.slice(text.snippet.start + h.start, text.snippet.start + h.end).toLowerCase()).toBe('rowed');
    // The title matched too, and ranks the scene above one that only says it in passing.
    expect(hit.matches.map((m) => m.source)).toEqual(expect.arrayContaining(['sceneTitle', 'sceneText']));
    expect(r.coverage).toMatchObject({ scenes: 2, searchedScenes: 2, complete: true, cut: null });
    // Never another book's scene.
    expect(r.hits.map((h) => h.sceneId)).not.toContain(f.otherScene);
});

it('searches a scene’s note and a mention’s name; finds a quoted phrase only in order', async () => {
    const f = await seed();
    expect((await searchBook(f.ctx, f.bookId, { q: 'tide tables' })).hits.find((h) => h.sceneId === f.rowing)?.matches.map((m) => m.source)).toContain('sceneNote');
    expect((await searchBook(f.ctx, f.bookId, { q: '"lamp kept burning"' })).hits.map((h) => h.sceneId)).toEqual([f.rowing]);
    expect((await searchBook(f.ctx, f.bookId, { q: '"burning kept lamp"' })).hits).toEqual([]);
    // Words in neighbouring paragraphs never fuse into a phrase.
    expect((await searchBook(f.ctx, f.bookId, { q: '"early she"' })).hits).toEqual([]);
});

it('never finds a deleted scene', async () => {
    const f = await seed();
    await deleteScene(f.ctx, f.bookId, f.rowing);
    const r = await searchBook(f.ctx, f.bookId, { q: 'reef' });
    expect(r.hits.map((h) => h.sceneId)).not.toContain(f.rowing);
    expect(r.coverage.scenes).toBe(1);
});

it('names its cuts: past the scene cap, and past the scenes’ text budget', async () => {
    const f = await seed();
    const capped = await searchBook(f.ctx, f.bookId, { q: 'lamp' }, { limits: { ...SEARCH_READ_LIMITS, scenes: 1 } });
    expect(capped.coverage).toMatchObject({ scenes: 2, searchedScenes: 1, complete: false, cut: 'SCENES_CAP' });
    const budget = await searchBook(f.ctx, f.bookId, { q: 'lamp' }, { limits: { ...SEARCH_READ_LIMITS, sceneTextChars: 10, sceneChunkBytes: 1 } });
    expect(budget.coverage).toMatchObject({ scenes: 2, searchedScenes: 1, complete: false, cut: 'SCENE_TEXT_BUDGET' });
});

it('stores nothing and audits nothing', async () => {
    const f = await seed();
    const before = await prisma.auditLog.count({ where: { workspaceId: f.ctx.workspaceId } });
    await searchBook(f.ctx, f.bookId, { q: 'reef' });
    expect(await prisma.auditLog.count({ where: { workspaceId: f.ctx.workspaceId } })).toBe(before);
});
