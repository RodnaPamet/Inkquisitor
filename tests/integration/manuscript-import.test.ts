/**
 * Importing a manuscript (Phase 5.1, D33), against a real database and 4.0's real reader (DOCX through mammoth in its
 * bounded worker):
 *
 *   - the preview writes nothing and answers the outline, the proposed split and a token;
 *   - the confirm writes the split the author chose, in one transaction, each scene with its first version (IMPORT);
 *     the file is not added to the source library (owner decision 3);
 *   - a different file is 409 IMPORT_FILE_CHANGED, an old preview 409 IMPORT_PREVIEW_EXPIRED, a plan that does not fit
 *     400 IMPORT_PLAN_INVALID, a PDF 400 IMPORT_FORMAT, an infected file refused — and none of them writes a row;
 *   - an import appends to what the manuscript holds;
 *   - a 150,000-word manuscript imports, in a number of statements that does not grow with its scenes (5.H times it).
 */
import { Client } from 'pg';
import { prisma } from '@/lib/db';
import { createBook } from '@/app-layer/usecases/books';
import { createChapter, getManuscriptOutline } from '@/app-layer/usecases/manuscript';
import { confirmManuscriptImport, previewManuscriptImport, type ManuscriptImportDeps } from '@/app-layer/usecases/manuscript-import';
import { getScene } from '@/app-layer/usecases/manuscript-scenes';
import type { ImportPlan } from '@/lib/manuscript/import-split';
import { makeDocx, makePdf } from '../helpers/source-files';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

const CLEAN: ManuscriptImportDeps = { scan: async () => ({ status: 'CLEAN' as const, engine: 'test', durationMs: 1 }) };
const enc = (s: string) => new TextEncoder().encode(s);
const header = (plan: ImportPlan, token: string, issuedAt: number) => Buffer.from(JSON.stringify({ token, issuedAt, ...plan }), 'utf8').toString('base64url');

async function setup() {
    const ctx = workspaceCtx(await createAccount());
    const bookId = (await createBook(ctx, { title: 'Imported' })).id;
    return { ctx, bookId };
}

const MARKDOWN = `Opening words before any chapter.

# Chapter One

## The arrival

Wren came ashore at dawn. <script>alert(1)</script>

***

By noon the tide had turned.

## The quay

The harbour master counted barrels.

# Chapter Two

Rain all week.
`;

const counts = async (bookId: string) => ({
    parts: await prisma.manuscriptPart.count({ where: { bookId } }),
    chapters: await prisma.manuscriptChapter.count({ where: { bookId } }),
    scenes: await prisma.manuscriptScene.count({ where: { bookId } }),
});

describe('two steps: preview, then the confirmed split', () => {
    it('previews without writing, then writes the plan the author chose, each scene with its first version', async () => {
        const { ctx, bookId } = await setup();
        const bytes = enc(MARKDOWN);
        const preview = await previewManuscriptImport(ctx, bookId, { bytes, filename: 'draft.md' }, CLEAN);
        expect(preview.format).toBe('MARKDOWN');
        expect(preview.outline.headings.map((h) => [h.level, h.text])).toEqual([
            [1, 'Chapter One'],
            [2, 'The arrival'],
            [2, 'The quay'],
            [1, 'Chapter Two'],
        ]);
        expect(preview.plan).toEqual({ levels: { part: null, chapter: 1, scene: 2 }, sceneBreaks: true, overrides: [] });
        expect(await counts(bookId)).toEqual({ parts: 0, chapters: 0, scenes: 0 });

        // The author keeps the levels but does not split on the scene break.
        const plan: ImportPlan = { ...preview.plan, sceneBreaks: false };
        const done = await confirmManuscriptImport(ctx, bookId, { bytes, filename: 'draft.md' }, header(plan, preview.token, preview.issuedAt), CLEAN);
        expect(done).toMatchObject({ parts: 1, chapters: 3, scenes: 4 });
        const outline = await getManuscriptOutline(ctx, bookId);
        expect(outline.singleDefaultPart).toBe(true);
        expect(outline.parts[0].chapters.map((c) => [c.title, c.scenes.map((s) => s.title)])).toEqual([
            [null, [null]],
            ['Chapter One', ['The arrival', 'The quay']],
            ['Chapter Two', [null]],
        ]);
        const arrival = outline.parts[0].chapters[1].scenes[0];
        const scene = await getScene(ctx, bookId, arrival.id);
        expect(scene.text).toBe('<p>Wren came ashore at dawn. &lt;script&gt;alert(1)&lt;/script&gt;</p><p>By noon the tide had turned.</p>');
        expect(scene.latestVersion).toBe(1);
        expect(await prisma.sceneVersion.findFirst({ where: { sceneId: arrival.id } })).toMatchObject({ source: 'IMPORT', versionNumber: 1 });
        // Manuscript only: nothing in the source library.
        expect(await prisma.source.count({ where: { library: { bookId } } })).toBe(0);
        expect(await prisma.auditLog.count({ where: { workspaceId: ctx.workspaceId, action: 'MANUSCRIPT_IMPORTED' } })).toBe(1);
    });

    it('reads a Word file through 4.0\'s reader, its heading styles as levels', async () => {
        const { ctx, bookId } = await setup();
        const bytes = makeDocx([{ heading: 'Part One', level: 1 }, { heading: 'Chapter 1', level: 2 }, { para: 'The first line.' }, { heading: 'Chapter 2', level: 2 }, { para: 'The second line.' }]);
        const preview = await previewManuscriptImport(ctx, bookId, { bytes, filename: 'draft.docx' }, CLEAN);
        expect(preview.format).toBe('DOCX');
        expect(preview.plan.levels).toEqual({ part: null, chapter: 1, scene: 2 });
        const plan: ImportPlan = { ...preview.plan, levels: { part: 1, chapter: 2, scene: null } };
        await confirmManuscriptImport(ctx, bookId, { bytes, filename: 'draft.docx' }, header(plan, preview.token, preview.issuedAt), CLEAN);
        const outline = await getManuscriptOutline(ctx, bookId);
        expect(outline.parts.map((p) => [p.title, p.chapters.map((c) => c.title)])).toEqual([['Part One', ['Chapter 1', 'Chapter 2']]]);
        expect(outline.totals.words).toBe(6);
    });

    it('appends to what the manuscript holds: chapters at the end of its last part', async () => {
        const { ctx, bookId } = await setup();
        await createChapter(ctx, bookId, { title: 'Written first' });
        const bytes = enc('# Imported chapter\n\nSome words.\n');
        const preview = await previewManuscriptImport(ctx, bookId, { bytes, filename: 'a.md' }, CLEAN);
        expect(preview.existing).toEqual({ parts: 1, chapters: 1, scenes: 0 });
        await confirmManuscriptImport(ctx, bookId, { bytes, filename: 'a.md' }, header(preview.plan, preview.token, preview.issuedAt), CLEAN);
        const outline = await getManuscriptOutline(ctx, bookId);
        expect(outline.parts).toHaveLength(1);
        expect(outline.parts[0].chapters.map((c) => c.title)).toEqual(['Written first', 'Imported chapter']);
    });
});

describe('refusals write nothing', () => {
    it('refuses another file, an old preview, a plan that does not fit, a PDF and an infected file', async () => {
        const { ctx, bookId } = await setup();
        const bytes = enc(MARKDOWN);
        const preview = await previewManuscriptImport(ctx, bookId, { bytes, filename: 'draft.md' }, CLEAN);
        const ok = header(preview.plan, preview.token, preview.issuedAt);
        await expect(confirmManuscriptImport(ctx, bookId, { bytes: enc(`${MARKDOWN}\nMore.`), filename: 'draft.md' }, ok, CLEAN)).rejects.toMatchObject({ details: { reason: 'IMPORT_FILE_CHANGED' } });
        await expect(confirmManuscriptImport(ctx, bookId, { bytes, filename: 'draft.md' }, ok, { ...CLEAN, now: preview.issuedAt + 2 * 60 * 60_000 })).rejects.toMatchObject({
            details: { reason: 'IMPORT_PREVIEW_EXPIRED' },
        });
        const badPlan = header({ ...preview.plan, levels: { part: 1, chapter: 1, scene: null } }, preview.token, preview.issuedAt);
        await expect(confirmManuscriptImport(ctx, bookId, { bytes, filename: 'draft.md' }, badPlan, CLEAN)).rejects.toMatchObject({ details: { reason: 'IMPORT_PLAN_INVALID', problem: 'LEVELS_NOT_DISTINCT' } });
        await expect(confirmManuscriptImport(ctx, bookId, { bytes, filename: 'draft.md' }, 'not-base64-json', CLEAN)).rejects.toMatchObject({ details: { reason: 'IMPORT_PLAN_INVALID' } });
        await expect(previewManuscriptImport(ctx, bookId, { bytes: await makePdf(['A page of text.']), filename: 'draft.pdf' }, CLEAN)).rejects.toMatchObject({ details: { reason: 'IMPORT_FORMAT' } });
        await expect(previewManuscriptImport(ctx, bookId, { bytes, filename: 'draft.md' }, { scan: async () => ({ status: 'INFECTED' as const, engine: 'test', durationMs: 1, threat: 'Eicar' }) })).rejects.toMatchObject({
            details: { reason: 'UPLOAD_INFECTED' },
        });
        expect(await counts(bookId)).toEqual({ parts: 0, chapters: 0, scenes: 0 });
    });
});

describe('every problem answered at once', () => {
    it('keeps a heading too long to be a title as text by default, and refuses a plan that makes it one, naming every problem', async () => {
        const { ctx, bookId } = await setup();
        const long = 'A heading that is really a whole paragraph styled as a heading '.repeat(5).trim();
        const bytes = enc(`# Chapter One\n\n## ${long}\n\nThe words under it.\n\n## A real scene\n\nMore words.\n`);
        const preview = await previewManuscriptImport(ctx, bookId, { bytes, filename: 'long.md' }, CLEAN);
        expect(preview.outline.headings.map((h) => h.titleTooLong)).toEqual([false, true, false]);
        // The proposed split keeps it as text: the author's words are not lost, and not cut to fit a title.
        expect(preview.plan.overrides).toEqual([[1, 'text']]);

        // The plain levels (no override) would make it a scene's title; with two other problems as well, all are named at once.
        const bad: ImportPlan = { levels: { part: 2, chapter: 2, scene: null }, sceneBreaks: false, overrides: [[7, 'scene']] };
        await expect(confirmManuscriptImport(ctx, bookId, { bytes, filename: 'long.md' }, header(bad, preview.token, preview.issuedAt), CLEAN)).rejects.toMatchObject({
            details: { reason: 'IMPORT_PLAN_INVALID', problems: ['LEVELS_NOT_DISTINCT', 'OVERRIDE_OUT_OF_RANGE'] },
        });
        const levelsOnly: ImportPlan = { ...preview.plan, overrides: [] };
        await expect(confirmManuscriptImport(ctx, bookId, { bytes, filename: 'long.md' }, header(levelsOnly, preview.token, preview.issuedAt), CLEAN)).rejects.toMatchObject({
            details: { reason: 'IMPORT_PLAN_INVALID', problems: ['HEADING_TOO_LONG'], headings: [1] },
        });
        expect(await counts(bookId)).toEqual({ parts: 0, chapters: 0, scenes: 0 });

        const done = await confirmManuscriptImport(ctx, bookId, { bytes, filename: 'long.md' }, header(preview.plan, preview.token, preview.issuedAt), CLEAN);
        expect(done).toMatchObject({ chapters: 1, scenes: 2 });
        const outline = await getManuscriptOutline(ctx, bookId);
        const first = await getScene(ctx, bookId, outline.parts[0].chapters[0].scenes[0].id);
        expect(first.text).toBe(`<p>${long}</p><p>The words under it.</p>`);
    });

    it('names every bound an import would pass, not only the first', async () => {
        const { ctx, bookId } = await setup();
        const parts = Array.from({ length: 101 }, (_, i) => `# Part ${i}\n\n## Chapter ${i}\n\nWords.\n`).join('\n');
        const bytes = enc(parts);
        const preview = await previewManuscriptImport(ctx, bookId, { bytes, filename: 'parts.md' }, CLEAN);
        const plan: ImportPlan = { levels: { part: 1, chapter: 2, scene: null }, sceneBreaks: false, overrides: [] };
        await expect(confirmManuscriptImport(ctx, bookId, { bytes, filename: 'parts.md' }, header(plan, preview.token, preview.issuedAt), CLEAN)).rejects.toMatchObject({
            details: { reason: 'TOO_MANY_PARTS', problems: ['TOO_MANY_PARTS'] },
        });
        expect(await counts(bookId)).toEqual({ parts: 0, chapters: 0, scenes: 0 });
    });

    it('refuses a token minted for another book of the same workspace and user', async () => {
        const { ctx, bookId } = await setup();
        const otherBook = (await createBook(ctx, { title: 'Another' })).id;
        const bytes = enc(MARKDOWN);
        const preview = await previewManuscriptImport(ctx, bookId, { bytes, filename: 'draft.md' }, CLEAN);
        await expect(confirmManuscriptImport(ctx, otherBook, { bytes, filename: 'draft.md' }, header(preview.plan, preview.token, preview.issuedAt), CLEAN)).rejects.toMatchObject({
            details: { reason: 'IMPORT_FILE_CHANGED' },
        });
        expect(await counts(otherBook)).toEqual({ parts: 0, chapters: 0, scenes: 0 });
    });
});

describe('scale', () => {
    /** Statements sent to PostgreSQL while `fn` runs. */
    async function statements<T>(fn: () => Promise<T>): Promise<{ result: T; count: number }> {
        const spy = jest.spyOn(Client.prototype, 'query');
        try {
            return { result: await fn(), count: spy.mock.calls.length };
        } finally {
            spy.mockRestore();
        }
    }

    function manuscript(chapters: number, scenesPerChapter: number, parasPerScene: number): string {
        const sentence = 'The tide came in over the stones and the gulls rose crying into the wind again.';
        const out: string[] = [];
        for (let c = 1; c <= chapters; c++) {
            out.push(`# Chapter ${c}`, '');
            for (let s = 1; s <= scenesPerChapter; s++) {
                out.push(`## Scene ${s}`, '');
                for (let k = 0; k < parasPerScene; k++) out.push(`${sentence} ${sentence}`, '');
            }
        }
        return out.join('\n');
    }

    async function importText(text: string) {
        const { ctx, bookId } = await setup();
        const bytes = enc(text);
        const preview = await previewManuscriptImport(ctx, bookId, { bytes, filename: 'big.md' }, CLEAN);
        const { result, count } = await statements(() => confirmManuscriptImport(ctx, bookId, { bytes, filename: 'big.md' }, header(preview.plan, preview.token, preview.issuedAt), CLEAN));
        return { result, count, words: preview.outline.words };
    }

    it('imports a 150,000-word manuscript, and its statements do not grow with its scenes within a batch', async () => {
        const big = await importText(manuscript(60, 5, 32));
        expect(big.words).toBeGreaterThanOrEqual(150_000);
        expect(big.result).toMatchObject({ chapters: 60, scenes: 300 });
        const small = await importText(manuscript(6, 5, 32));
        expect(small.result).toMatchObject({ chapters: 6, scenes: 30 });
        // Both fit one batch of scenes: the same statements, whatever the size.
        expect(big.count).toBe(small.count);
    }, 120_000);
});
