/**
 * The full export (Phase 5.H-a, D36), against a real database: ONE AES-256 (WinZip AE-2) archive of everything the
 * workspace holds, read back here with the INDEPENDENT AE-2 reader (`tests/helpers/ae2-zip.ts`, node:crypto alone):
 *
 *   - every file the archive holds is described in its README, and every file the README names is there;
 *   - each book's bible bundle is byte for byte what the bible export writes (and imports back);
 *   - the manuscript is a DOCX a reader opens and Markdown, scenes in order, a deleted scene left out;
 *   - every history and decision is there as JSON Lines, its count in the manifest equal to the database's;
 *   - the passphrase opens it, a wrong one does not; it is judged (400) and never stored or audited;
 *   - only an OWNER may export (`workspace.export`), audited with counts only.
 */
import mammoth from 'mammoth';
import { prisma } from '@/lib/db';
import { createBook } from '@/app-layer/usecases/books';
import { createElement, updateElementFields } from '@/app-layer/usecases/bible-elements';
import { createChapter, createScene, deleteScene } from '@/app-layer/usecases/manuscript';
import { checkpointScene, saveSceneText } from '@/app-layer/usecases/manuscript-scenes';
import { exportBibleBundle } from '@/app-layer/usecases/bible-export';
import { importBibleBundle } from '@/app-layer/usecases/bible-import';
import { startWorkspaceExport } from '@/app-layer/usecases/workspace-export';
import { BOOK_FILES, BOOK_TABLE_FILES, ROOT_FILES } from '@/lib/export/archive-layout';
import { ForbiddenError, ValidationError } from '@/lib/errors/types';
import { readAe2Zip, readCentralDirectory } from '../helpers/ae2-zip';
import { addMember, createAccount, createBareUser, workspaceCtx } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

const PASSPHRASE = 'the salt roads at low tide';

async function collect(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
    const chunks: Buffer[] = [];
    const reader = stream.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
}

async function workspace() {
    const owner = await createAccount();
    const ctx = workspaceCtx(owner);
    const book = await createBook(ctx, { title: 'The Salt Roads', logline: 'A run across a drowned country.' });
    const mara = await createElement(ctx, book.id, { kind: 'CHARACTER', name: 'Mara Quell' });
    await updateElementFields(ctx, book.id, mara.id, { fields: [{ key: 'want', value: 'To reach the cape before the tide.' }], baseVersion: mara.versionNumber });
    const chapter = await createChapter(ctx, book.id, { title: 'The Harbour' });
    const one = (await createScene(ctx, book.id, { chapterId: chapter.id, title: 'Low tide' })).id;
    const s1 = await saveSceneText(ctx, book.id, one, { html: '<p>Mara stood at the rail. <em>The boats</em> were gone.</p>', baseRevision: 0 }, { enqueueProseCheck: async () => undefined });
    await saveSceneText(ctx, book.id, one, { html: '<p>Mara stood at the rail. <em>The boats</em> were gone, all of them.</p>', baseRevision: s1.revision }, { enqueueProseCheck: async () => undefined });
    await checkpointScene(ctx, book.id, one, { revision: s1.revision + 1 });
    const two = (await createScene(ctx, book.id, { chapterId: chapter.id, title: 'High water' })).id;
    await saveSceneText(ctx, book.id, two, { html: '<p>The water came over the quay.</p>', baseRevision: 0 }, { enqueueProseCheck: async () => undefined });
    const gone = (await createScene(ctx, book.id, { chapterId: chapter.id, title: 'Cut scene' })).id;
    await saveSceneText(ctx, book.id, gone, { html: '<p>A scene the author cut.</p>', baseRevision: 0 }, { enqueueProseCheck: async () => undefined });
    await deleteScene(ctx, book.id, gone);
    const second = await createBook(ctx, { title: 'Second book' });
    return { owner, ctx, bookId: book.id, secondId: second.id, gone };
}

describe('the archive', () => {
    let f: Awaited<ReturnType<typeof workspace>>;
    let zip: Buffer;
    let files: Map<string, Buffer>;

    beforeAll(async () => {
        f = await workspace();
        const started = await startWorkspaceExport(f.ctx, { passphrase: PASSPHRASE }, new Date('2026-11-27T12:00:00.000Z'));
        expect(started.fileName).toMatch(/-inkquisitor-export-2026-11-27\.zip$/);
        zip = await collect(started.stream);
        files = readAe2Zip(zip, PASSPHRASE);
    });

    it('is AES-256 AE-2 throughout, and a wrong passphrase opens nothing', () => {
        for (const e of readCentralDirectory(zip)) expect(e).toMatchObject({ method: 99, crc: 0, aes: { vendorVersion: 2, vendorId: 'AE', strength: 3 } });
        expect(() => readAe2Zip(zip, 'not the passphrase at all')).toThrow(/wrong password|authentication/);
        expect(zip.includes(Buffer.from('Mara stood'))).toBe(false);
    });

    it('describes every file it holds, and holds every file it describes', () => {
        const readme = files.get(ROOT_FILES.readme.path)!.toString('utf8');
        const names = [...files.keys()];
        const folder = names.find((n) => n.endsWith(`/${BOOK_FILES.book.path}`))!.replace(BOOK_FILES.book.path, '');
        expect(folder).toBe('books/001-the-salt-roads/');
        for (const n of names) {
            const rel = n.startsWith('books/') ? n.slice(n.indexOf('/', 'books/'.length) + 1) : n;
            expect(readme).toContain(`\`${rel}\``);
        }
        for (const p of [...Object.values(ROOT_FILES).map((r) => r.path)]) expect(names).toContain(p);
        for (const p of [...Object.values(BOOK_FILES).map((b) => b.path), ...BOOK_TABLE_FILES.map((b) => b.path)]) {
            expect(names).toContain(folder + p);
            expect(names).toContain(`books/002-second-book/${p}`);
        }
    });

    it('carries the bible bundle byte for byte, and it imports back', async () => {
        const bundle = files.get(`books/001-the-salt-roads/${BOOK_FILES.bundle.path}`)!;
        const direct = await exportBibleBundle(f.ctx, f.bookId);
        expect(bundle.equals(Buffer.from(direct.bytes))).toBe(true);
        const target = await createBook(f.ctx, { title: 'Imported' });
        await importBibleBundle(f.ctx, target.id, new Uint8Array(bundle), { bookDetails: 'apply' }, { scan: async () => ({ status: 'CLEAN', engine: 'test', durationMs: 0 }) });
        const again = await exportBibleBundle(f.ctx, target.id);
        expect(Buffer.from(again.bytes).equals(bundle)).toBe(true);
    });

    it('carries the manuscript as a DOCX a reader opens and as Markdown, in order, without the deleted scene', async () => {
        const docx = files.get(`books/001-the-salt-roads/${BOOK_FILES.docx.path}`)!;
        const { value: html } = await mammoth.convertToHtml({ buffer: docx });
        expect(html).toContain('<h2>The Harbour</h2>');
        expect(html).toContain('<h3>Low tide</h3>');
        expect(html).toContain('<em>The boats</em> were gone, all of them.');
        expect(html.indexOf('Low tide')).toBeLessThan(html.indexOf('High water'));
        expect(html).not.toContain('A scene the author cut');
        const md = files.get(`books/001-the-salt-roads/${BOOK_FILES.markdown.path}`)!.toString('utf8');
        expect(md).toContain('### Low tide\n\nMara stood at the rail. *The boats* were gone, all of them.');
        const outline = JSON.parse(files.get(`books/001-the-salt-roads/${BOOK_FILES.outline.path}`)!.toString('utf8'));
        expect(outline.parts[0].chapters[0].scenes.map((s: { title: string }) => s.title)).toEqual(['Low tide', 'High water']);
    });

    it('carries every history row the database holds, counted in the manifest; a deleted scene’s versions too', async () => {
        const manifest = JSON.parse(files.get(ROOT_FILES.manifest.path)!.toString('utf8'));
        const lines = (path: string) => files.get(path)!.toString('utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
        const versions = lines('books/001-the-salt-roads/history/scene-versions.jsonl');
        expect(versions.length).toBe(await prisma.sceneVersion.count({ where: { bookId: f.bookId } }));
        expect(versions.some((v: { sceneId: string; text: string }) => v.sceneId === f.gone && v.text.includes('A scene the author cut'))).toBe(true);
        const bible = lines('books/001-the-salt-roads/history/bible-versions.jsonl');
        expect(bible.length).toBe(await prisma.bibleEntryVersion.count({ where: { bookId: f.bookId } }));
        expect(JSON.stringify(bible)).toContain('To reach the cape before the tide.');
        expect(typeof bible[0].snapshot).toBe('object');
        for (const [path, n] of Object.entries(manifest.files as Record<string, number>)) {
            if (path.endsWith('.jsonl')) expect(lines(path).length).toBe(n);
        }
        expect(manifest).toMatchObject({ format: 'inkquisitor-export', formatVersion: 1, exportedAt: '2026-11-27T12:00:00.000Z' });
        const audit = lines(ROOT_FILES.audit.path);
        expect(audit.length).toBeGreaterThan(0);
        expect(JSON.stringify(audit)).not.toContain(PASSPHRASE);
    });
});

describe('who and what', () => {
    it('refuses a weak passphrase (400, its reason) and anyone but an OWNER (403, audited); the passphrase is never stored', async () => {
        const owner = await createAccount();
        const ctx = workspaceCtx(owner);
        await expect(startWorkspaceExport(ctx, { passphrase: 'short' })).rejects.toMatchObject({ details: { reason: 'PASSPHRASE_TOO_SHORT' } });
        await expect(startWorkspaceExport(ctx, { passphrase: 'short' })).rejects.toBeInstanceOf(ValidationError);
        await expect(startWorkspaceExport(ctx, { passphrase: 'x', extra: 1 })).rejects.toThrow();
        const editor = await createBareUser();
        await addMember(owner.workspaceId, editor.id, 'EDITOR');
        await expect(startWorkspaceExport(workspaceCtx({ ...owner, userId: editor.id }, 'EDITOR'), { passphrase: PASSPHRASE })).rejects.toBeInstanceOf(ForbiddenError);
        const started = await startWorkspaceExport(ctx, { passphrase: PASSPHRASE });
        await collect(started.stream);
        const rows = await prisma.auditLog.findMany({ where: { workspaceId: owner.workspaceId }, select: { action: true, detailsJson: true } });
        expect(rows.find((r) => r.action === 'WORKSPACE_EXPORTED')?.detailsJson).toEqual({ bookCount: 0, formatVersion: 1 });
        expect(rows.find((r) => r.action === 'AUTHZ_DENIED')?.detailsJson).toMatchObject({ permission: 'workspace.export' });
        expect(JSON.stringify(rows)).not.toContain(PASSPHRASE);
        const [{ hit }] = await prisma.$queryRaw<Array<{ hit: number }>>`SELECT count(*)::int AS hit FROM "AuditLog" WHERE "detailsJson"::text LIKE ${'%' + PASSPHRASE + '%'}`;
        expect(hit).toBe(0);
    });
});
