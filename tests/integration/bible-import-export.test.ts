/**
 * Bible import and export against a real database (Phase 1.3).
 *
 *   - THE ROUND TRIP: export a bible holding every field type, a CUSTOM
 *     element, rich text, lists, scales, choices and relations (directed and
 *     symmetric, with and without notes) — import it into an empty book —
 *     export that book: the two zips are byte-identical;
 *   - every imported element gets version 1 with source IMPORT, and a second
 *     import of the same bundle writes nothing; a changed element writes one
 *     version, a field the file leaves out is cleared;
 *   - a bundle with any problem is refused whole, naming each problem, and
 *     writes nothing; values are sanitised on the way in;
 *   - a virus-scan verdict of INFECTED refuses the upload, and a scan that
 *     cannot run refuses it in strict mode;
 *   - an import reaches only the caller's workspace, and needs `bible.edit`;
 *   - a concept note becomes a RESEARCH element, idempotent per slug.
 */
import { prisma } from '@/lib/db';
import { readZip, writeZip } from '@/lib/archive/zip';
import { createElement, getElement, listElements, updateElementFields } from '@/app-layer/usecases/bible-elements';
import { addRelation } from '@/app-layer/usecases/bible-relations';
import { getVersion } from '@/app-layer/usecases/bible-versions';
import { createBook, getBook } from '@/app-layer/usecases/books';
import { exportBibleBundle, exportBiblePdf } from '@/app-layer/usecases/bible-export';
import { importBibleBundle, importConceptNote, type ImportDeps } from '@/app-layer/usecases/bible-import';
import { BUNDLE_ZIP_LIMITS } from '@/app-layer/schemas/bible-transfer';
import { AppError, ForbiddenError, NotFoundError } from '@/lib/errors/types';
import type { ScanResult } from '@/lib/storage/av-scan';
import { addMember, createAccount, createBareUser, workspaceCtx } from '../helpers/workspaces';
import { pdfText } from '../helpers/pdf-text';

afterAll(() => prisma.$disconnect());

const clean: ImportDeps = { scan: async (): Promise<ScanResult> => ({ status: 'CLEAN', engine: 'test', durationMs: 0 }) };
const infected: ImportDeps = { scan: async (): Promise<ScanResult> => ({ status: 'INFECTED', threat: 'Eicar-Test-Signature', engine: 'test', durationMs: 0 }) };

let owner: Awaited<ReturnType<typeof createAccount>>;
let ctx: ReturnType<typeof workspaceCtx>;

beforeAll(async () => {
    owner = await createAccount({ workspaceName: 'Transfer desk' });
    ctx = workspaceCtx(owner);
});

/** The error's `details.reason` and, for a refused bundle, its problems. */
async function refusalOf(p: Promise<unknown>): Promise<{ status: number; reason: unknown; problems: Array<{ path: string; reason: string; key?: string }> }> {
    try {
        await p;
    } catch (err) {
        if (!(err instanceof AppError)) throw err;
        const details = (err.details ?? {}) as { reason?: unknown; problems?: Array<{ path: string; reason: string; key?: string }> };
        return { status: err.status, reason: details.reason, problems: details.problems ?? [] };
    }
    throw new Error('the call was not refused');
}

/** A book holding a little of everything. */
async function seedRichBook(title = 'The Salt Roads') {
    const book = await createBook(ctx, { title, logline: 'A ferrywoman crosses a drowned country.\n\nShe owes a debt.', genre: 'Fantasy', targetLength: 90_000, stage: 'PLANNING' });
    const mara = await createElement(ctx, book.id, {
        kind: 'CHARACTER',
        name: 'Mara Vell',
        status: 'IN_PROGRESS',
        summary: 'A ferrywoman.\n\nShe fears the "water" & owes the guild: a < b.',
        fields: [
            { key: 'role', value: 'Lead' },
            { key: 'prominence', value: 'carries_book' },
            { key: 'defining_traits', value: ['stubborn', 'dry-witted', '#hash', '- dash', 'yes'] },
            { key: 'speaking_voice', value: '<h2>Voice</h2><p>Short <strong>clipped</strong> sentences &amp; <a href="https://example.test/x?a=1&b=2">a link</a>.</p><ul><li><p>never swears</p></li></ul><p>Line one<br>line two</p>' },
            { key: 'agency', value: 4 },
            { key: 'want', value: '123' },
        ],
    });
    const tam = await createElement(ctx, book.id, { kind: 'CHARACTER', name: 'Tam Vell', status: 'SETTLED' });
    const guild = await createElement(ctx, book.id, {
        kind: 'FACTION',
        name: 'The Salt Guild',
        fields: [
            { key: 'purpose', value: 'Tax the ferries' },
            { key: 'reach', value: 2 },
            { key: 'group_type', value: 'ruling_body' },
        ],
    });
    const tides = await createElement(ctx, book.id, {
        kind: 'CUSTOM',
        name: 'Tide tables',
        customLabel: 'Almanac',
        fields: [
            { key: 'key_details', value: ['Spring tides', 'Neap tides'] },
            { key: 'connections', value: '<p>Every crossing.</p>' },
        ],
    });
    const almanac = await createElement(ctx, book.id, { kind: 'CUSTOM', name: 'Old almanac', customLabel: 'Almanac' });
    await addRelation(ctx, book.id, { fromElementId: mara.id, toElementId: guild.id, type: 'member_of', note: 'Reluctantly,\nsince the flood.' });
    await addRelation(ctx, book.id, { fromElementId: mara.id, toElementId: tam.id, type: 'sibling_of' });
    await addRelation(ctx, book.id, { fromElementId: tides.id, toElementId: almanac.id, type: 'variant_of', note: 'The older edition' });
    return { book, mara, tam, guild, tides, almanac };
}

const versionsOf = (bookId: string) => prisma.bibleEntryVersion.count({ where: { bookId } });

describe('the round trip', () => {
    it('export → import into an empty book → export is byte-identical', async () => {
        const { book } = await seedRichBook();
        const first = await exportBibleBundle(ctx, book.id);
        expect(first.contentType).toBe('application/zip');
        expect(first.fileName).toBe('the-salt-roads-bible.zip');

        const empty = await createBook(ctx, { title: 'Empty shelf' });
        const report = await importBibleBundle(ctx, empty.id, first.bytes, { bookDetails: 'apply' }, clean);
        expect(report.elements).toEqual({ created: 5, updated: 0, unchanged: 0 });
        expect(report.versionsWritten).toBe(5);
        expect(report.relations).toEqual({ created: 3, updated: 0, unchanged: 0 });
        expect(report.bookDetailsApplied).toBe(true);

        const second = await exportBibleBundle(ctx, empty.id);
        expect(second.fileName).toBe('the-salt-roads-bible.zip');
        expect(Buffer.from(second.bytes).equals(Buffer.from(first.bytes))).toBe(true);

        // Every imported element starts its history with an IMPORT version.
        for (const item of report.items) {
            const v1 = await getVersion(ctx, empty.id, item.id, 1);
            expect([item.slug, v1.source, v1.authorId]).toEqual([item.slug, 'IMPORT', owner.userId]);
        }
        expect((await getBook(ctx, empty.id)).title).toBe('The Salt Roads');
    });

    it('round-trips a value that deflates past the import’s bomb ratio: the export stores that file', async () => {
        const book = await createBook(ctx, { title: 'Repetitive' });
        // 90,000 characters of one letter: deflated, a ratio far past 100.
        await createElement(ctx, book.id, { kind: 'THEME', name: 'Refrain', slug: 'refrain', fields: [{ key: 'stance', value: `<p>${'a'.repeat(90_000)}</p>` }] });
        const first = await exportBibleBundle(ctx, book.id);
        const empty = await createBook(ctx, { title: 'Repetitive copy' });
        expect((await importBibleBundle(ctx, empty.id, first.bytes, { bookDetails: 'apply' }, clean)).elements.created).toBe(1);
        expect(Buffer.from((await exportBibleBundle(ctx, empty.id)).bytes).equals(Buffer.from(first.bytes))).toBe(true);
    });

    it('exporting an unchanged bible twice gives the same bytes', async () => {
        const { book } = await seedRichBook('Twice told');
        const a = await exportBibleBundle(ctx, book.id);
        const b = await exportBibleBundle(ctx, book.id);
        expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    });
});

describe('idempotent per slug', () => {
    it('importing the same bundle twice writes nothing the second time', async () => {
        const { book } = await seedRichBook('Idempotent');
        const bundle = await exportBibleBundle(ctx, book.id);
        const target = await createBook(ctx, { title: 'Target' });
        await importBibleBundle(ctx, target.id, bundle.bytes, {}, clean);
        const before = await versionsOf(target.id);
        const relationsBefore = await prisma.bibleRelation.count({ where: { bookId: target.id } });

        const again = await importBibleBundle(ctx, target.id, bundle.bytes, {}, clean);
        expect(again.elements).toEqual({ created: 0, updated: 0, unchanged: 5 });
        expect(again.versionsWritten).toBe(0);
        expect(again.relations).toEqual({ created: 0, updated: 0, unchanged: 3 });
        expect(again.bookDetailsApplied).toBe(false);
        expect(await versionsOf(target.id)).toBe(before);
        expect(await prisma.bibleRelation.count({ where: { bookId: target.id } })).toBe(relationsBefore);
        // Book details are left alone unless asked for.
        expect((await getBook(ctx, target.id)).title).toBe('Target');
    });

    it('a changed element writes one IMPORT version; a field the file leaves out is cleared; a changed note is updated', async () => {
        const { book, mara } = await seedRichBook('Changed');
        const bundle = await exportBibleBundle(ctx, book.id);
        const files = readZip(bundle.bytes, BUNDLE_ZIP_LIMITS);
        const path = 'character/mara-vell.md';
        const original = new TextDecoder().decode(files.get(path)!);
        const edited = original
            .replace('  role: Lead\n', '  role: Lead hand\n')
            .replace('  want: "123"\n', '')
            .replace('    note: |-\n      Reluctantly,\n      since the flood.\n', '    note: Gladly\n');
        expect(edited).not.toBe(original);
        files.set(path, new TextEncoder().encode(edited));

        const report = await importBibleBundle(ctx, book.id, writeZip(files), {}, clean);
        expect(report.elements).toEqual({ created: 0, updated: 1, unchanged: 4 });
        expect(report.versionsWritten).toBe(1);
        expect(report.relations.updated).toBe(1);
        const item = report.items.find((i) => i.slug === 'mara-vell')!;
        expect(item).toMatchObject({ id: mara.id, outcome: 'updated', versionNumber: 2 });
        expect((await getVersion(ctx, book.id, mara.id, 2)).source).toBe('IMPORT');
        const now = await getElement(ctx, book.id, mara.id);
        const field = (k: string) => now.fields.find((f) => f.key === k)?.value;
        expect(field('role')).toBe('Lead hand');
        expect(field('want')).toBeNull();
        expect(now.relations.find((r) => r.type === 'member_of')?.note).toBe('Gladly');
    });

    it('a bundle written before a template gained a field leaves that field alone; a field its writer knew and it leaves out is cleared', async () => {
        const { book, mara } = await seedRichBook('Older template');
        const bundle = await exportBibleBundle(ctx, book.id);
        const files = readZip(bundle.bytes, BUNDLE_ZIP_LIMITS);
        // As a bundle written before CHARACTER had `want` and `role` would be:
        // the manifest's list lacks them and the file carries neither.
        const manifest = JSON.parse(new TextDecoder().decode(files.get('manifest.json')!)) as { templateFields: Record<string, string[]> };
        manifest.templateFields.character = manifest.templateFields.character.filter((k) => k !== 'want' && k !== 'role');
        files.set('manifest.json', new TextEncoder().encode(JSON.stringify(manifest)));
        const path = 'character/mara-vell.md';
        const original = new TextDecoder().decode(files.get(path)!);
        // The writer knew `agency` and left it out: that one is cleared.
        const older = original.replace('  want: "123"\n', '').replace('  role: Lead\n', '').replace('  agency: 4\n', '');
        expect(older).not.toContain('want:');
        expect(older).not.toContain('agency:');
        files.set(path, new TextEncoder().encode(older));

        const report = await importBibleBundle(ctx, book.id, writeZip(files), {}, clean);
        expect(report.elements).toEqual({ created: 0, updated: 1, unchanged: 4 });
        const now = await getElement(ctx, book.id, mara.id);
        const field = (k: string) => now.fields.find((f) => f.key === k)?.value;
        expect([field('want'), field('role'), field('agency')]).toEqual(['123', 'Lead', null]);

        // A manifest without the list (written by hand) claims every current key.
        files.set('manifest.json', new TextEncoder().encode(JSON.stringify({ format: 'inkquisitor-bible', version: 1 })));
        await importBibleBundle(ctx, book.id, writeZip(files), {}, clean);
        const after = await getElement(ctx, book.id, mara.id);
        expect(after.fields.find((f) => f.key === 'want')?.value).toBeNull();
    });

    it('takes back a bundle a desktop zipped as a folder (Finder, Windows), its litter skipped', async () => {
        const { book } = await seedRichBook('Rezipped');
        const exported = readZip((await exportBibleBundle(ctx, book.id)).bytes, BUNDLE_ZIP_LIMITS);
        const rezipped = new Map<string, Uint8Array>();
        for (const [name, bytes] of exported) {
            rezipped.set(`the-salt-roads-bible/${name}`, bytes);
            rezipped.set(`__MACOSX/the-salt-roads-bible/._${name.split('/').pop()}`, new Uint8Array([0, 5, 22, 7]));
        }
        rezipped.set('the-salt-roads-bible/.DS_Store', new Uint8Array([0, 0, 0, 1]));
        const target = await createBook(ctx, { title: 'Rezipped target' });
        const report = await importBibleBundle(ctx, target.id, writeZip(rezipped), {}, clean);
        expect(report.elements).toEqual({ created: 5, updated: 0, unchanged: 0 });

        // Two folders, or a folder beside a root file, are not one bundle folder.
        rezipped.set('other/manifest.json', exported.get('manifest.json')!);
        expect((await refusalOf(importBibleBundle(ctx, target.id, writeZip(rezipped), {}, clean))).problems).toContainEqual({ path: 'manifest.json', reason: 'MANIFEST_MISSING' });
    });

    it('merges: elements the bundle does not name are left alone', async () => {
        const { book } = await seedRichBook('Merge source');
        const bundle = await exportBibleBundle(ctx, book.id);
        const target = await createBook(ctx, { title: 'Merge target' });
        const own = await createElement(ctx, target.id, { kind: 'THEME', name: 'Debt' });
        await importBibleBundle(ctx, target.id, bundle.bytes, {}, clean);
        const slugs = (await listElements(ctx, target.id)).map((e) => e.slug);
        expect(slugs).toContain(own.slug);
        expect(slugs).toHaveLength(6);
    });
});

/** A bundle of one file set, built through the exporter's own zip writer. */
function bundleOf(files: Record<string, string>): Uint8Array {
    return writeZip(new Map([['manifest.json', '{"format":"inkquisitor-bible","version":1}\n'], ...Object.entries(files)]));
}

describe('a bundle with a problem is refused whole, and writes nothing', () => {
    let bookId: string;
    beforeAll(async () => {
        bookId = (await createBook(ctx, { title: 'Refusals' })).id;
        await createElement(ctx, bookId, { kind: 'THEME', name: 'Held', slug: 'held' });
    });

    it.each([
        ['an unknown kind directory', { 'villain/x.md': '---\nkind: CHARACTER\nname: X\nslug: x\nstatus: DRAFT\n---\n' }, { path: 'villain/x.md', reason: 'UNEXPECTED_ENTRY' }],
        ['an unknown kind', { 'character/x.md': '---\nkind: VILLAIN\nname: X\nslug: x\nstatus: DRAFT\n---\n' }, { path: 'character/x.md', reason: 'ELEMENT_INVALID', key: 'kind' }],
        ['an unknown field key', { 'character/x.md': '---\nkind: CHARACTER\nname: X\nslug: x\nstatus: DRAFT\nfields:\n  shoe_size: "9"\n---\n' }, { path: 'character/x.md', reason: 'UNKNOWN_FIELD', key: 'fields.shoe_size' }],
        ['a choice the field does not offer', { 'character/x.md': '---\nkind: CHARACTER\nname: X\nslug: x\nstatus: DRAFT\nfields:\n  prominence: villain\n---\n' }, { path: 'character/x.md', reason: 'NOT_AN_OPTION', key: 'fields.prominence' }],
        ['a scale out of range', { 'character/x.md': '---\nkind: CHARACTER\nname: X\nslug: x\nstatus: DRAFT\nfields:\n  agency: 9\n---\n' }, { path: 'character/x.md', reason: 'OUT_OF_RANGE', key: 'fields.agency' }],
        ['an unknown frontmatter key', { 'character/x.md': '---\nkind: CHARACTER\nname: X\nslug: x\nstatus: DRAFT\nmood: grim\n---\n' }, { path: 'character/x.md', reason: 'UNKNOWN_KEY', key: 'mood' }],
        ['a kind that does not match its directory', { 'setting/x.md': '---\nkind: CHARACTER\nname: X\nslug: x\nstatus: DRAFT\n---\n' }, { path: 'setting/x.md', reason: 'KIND_MISMATCH', key: 'kind' }],
        ['a slug that does not match its file', { 'character/x.md': '---\nkind: CHARACTER\nname: X\nslug: y\nstatus: DRAFT\n---\n' }, { path: 'character/x.md', reason: 'SLUG_MISMATCH', key: 'slug' }],
        ['a custom element with no label', { 'custom/x.md': '---\nkind: CUSTOM\nname: X\nslug: x\nstatus: DRAFT\n---\n' }, { path: 'custom/x.md', reason: 'CUSTOM_LABEL_REQUIRED', key: 'customLabel' }],
        ['a relation to a slug nobody holds', { 'character/x.md': '---\nkind: CHARACTER\nname: X\nslug: x\nstatus: DRAFT\nrelations:\n  - type: loves\n    to: nobody\n---\n' }, { path: 'character/x.md', reason: 'RELATION_TARGET_UNKNOWN', key: 'relations.0' }],
        ['a relation type the kinds do not allow', { 'character/x.md': '---\nkind: CHARACTER\nname: X\nslug: x\nstatus: DRAFT\nrelations:\n  - type: member_of\n    to: held\n---\n' }, { path: 'character/x.md', reason: 'RELATION_TYPE_NOT_ALLOWED', key: 'relations.0' }],
        ['a slug another kind already holds in the book', { 'character/held.md': '---\nkind: CHARACTER\nname: Held\nslug: held\nstatus: DRAFT\n---\n' }, { path: 'character/held.md', reason: 'KIND_CONFLICT', key: 'kind' }],
        ['a YAML alias', { 'character/x.md': '---\nkind: CHARACTER\nname: &n X\nslug: x\nstatus: DRAFT\nsummary: *n\n---\n' }, { path: 'character/x.md', reason: 'YAML_ALIAS' }],
        ['a YAML tag', { 'character/x.md': '---\nkind: CHARACTER\nname: !!binary WA==\nslug: x\nstatus: DRAFT\n---\n' }, { path: 'character/x.md', reason: 'YAML_TAG' }],
    ])('%s', async (_label, files, problem) => {
        const before = await prisma.bibleElement.count({ where: { bookId } });
        const versions = await versionsOf(bookId);
        // A valid element alongside: an atomic import writes it neither.
        const refused = await refusalOf(importBibleBundle(ctx, bookId, bundleOf({ ...files, 'theme/fine.md': '---\nkind: THEME\nname: Fine\nslug: fine\nstatus: DRAFT\n---\n' }), {}, clean));
        expect(refused.status).toBe(400);
        expect(refused.reason).toBe('BUNDLE_REFUSED');
        expect(refused.problems).toContainEqual(problem);
        expect(await prisma.bibleElement.count({ where: { bookId } })).toBe(before);
        expect(await versionsOf(bookId)).toBe(versions);
    });

    it('collects every problem of a bundle at once', async () => {
        const refused = await refusalOf(
            importBibleBundle(
                ctx,
                bookId,
                bundleOf({
                    'character/a.md': '---\nkind: CHARACTER\nname: A\nslug: a\nstatus: DRAFT\nfields:\n  agency: 0\n  prominence: nope\n---\n',
                    'stray.txt': 'hello',
                }),
                {},
                clean,
            ),
        );
        expect(refused.problems).toEqual(
            expect.arrayContaining([
                { path: 'character/a.md', reason: 'OUT_OF_RANGE', key: 'fields.agency' },
                { path: 'character/a.md', reason: 'NOT_AN_OPTION', key: 'fields.prominence' },
                { path: 'stray.txt', reason: 'UNEXPECTED_ENTRY' },
            ]),
        );
    });

    it('refuses an archive without a manifest, one that is not a zip, and an empty one', async () => {
        expect((await refusalOf(importBibleBundle(ctx, bookId, writeZip(new Map([['theme/a.md', '---\n---\n']])), {}, clean))).problems).toContainEqual({ path: 'manifest.json', reason: 'MANIFEST_MISSING' });
        expect((await refusalOf(importBibleBundle(ctx, bookId, new TextEncoder().encode('just text, not a zip archive at all'), {}, clean))).problems).toEqual([{ path: '', reason: 'NOT_A_ZIP' }]);
        expect((await refusalOf(importBibleBundle(ctx, bookId, bundleOf({}), {}, clean))).problems).toEqual([{ path: '', reason: 'BUNDLE_EMPTY' }]);
        expect((await refusalOf(importBibleBundle(ctx, bookId, bundleOf({ 'theme/a.md': '---\nkind: THEME\nname: A\nslug: a\nstatus: DRAFT\n---\n' }), { bookDetails: 'apply' }, clean))).problems).toContainEqual({
            path: 'book.md',
            reason: 'BOOK_FILE_MISSING',
        });
    });

    it('refuses a relation the bundle states twice: one type to one target twice, or a symmetric one from both ends', async () => {
        const before = await prisma.bibleRelation.count({ where: { bookId } });
        const twice = await refusalOf(
            importBibleBundle(
                ctx,
                bookId,
                bundleOf({
                    'character/a.md': '---\nkind: CHARACTER\nname: A\nslug: a\nstatus: DRAFT\nrelations:\n  - type: sibling_of\n    to: b\n    note: one\n  - type: sibling_of\n    to: b\n    note: two\n---\n',
                    'character/b.md': '---\nkind: CHARACTER\nname: B\nslug: b\nstatus: DRAFT\n---\n',
                }),
                {},
                clean,
            ),
        );
        expect(twice.problems).toEqual([{ path: 'character/a.md', reason: 'DUPLICATE_RELATION', key: 'relations.1' }]);
        const bothEnds = await refusalOf(
            importBibleBundle(
                ctx,
                bookId,
                bundleOf({
                    'character/a.md': '---\nkind: CHARACTER\nname: A\nslug: a\nstatus: DRAFT\nrelations:\n  - type: sibling_of\n    to: b\n    note: from a\n---\n',
                    'character/b.md': '---\nkind: CHARACTER\nname: B\nslug: b\nstatus: DRAFT\nrelations:\n  - type: sibling_of\n    to: a\n    note: from b\n---\n',
                }),
                {},
                clean,
            ),
        );
        expect(bothEnds.problems).toEqual([{ path: 'character/b.md', reason: 'DUPLICATE_RELATION', key: 'relations.0' }]);
        expect(await prisma.bibleRelation.count({ where: { bookId } })).toBe(before);
        // A directed type from both ends is two facts, not one: accepted.
        const directed = await importBibleBundle(
            ctx,
            bookId,
            bundleOf({
                'character/m.md': '---\nkind: CHARACTER\nname: M\nslug: m\nstatus: DRAFT\nrelations:\n  - type: mentor_of\n    to: n\n---\n',
                'character/n.md': '---\nkind: CHARACTER\nname: N\nslug: n\nstatus: DRAFT\nrelations:\n  - type: mentor_of\n    to: m\n---\n',
            }),
            {},
            clean,
        );
        expect(directed.relations.created).toBe(2);
    });

    it('refuses a zip bomb before inflating it', async () => {
        const bomb = writeZip(new Map<string, string | Uint8Array>([['manifest.json', '{"format":"inkquisitor-bible","version":1}\n'], ['theme/bomb.md', new Uint8Array(9 * 1024 * 1024)]]));
        const refused = await refusalOf(importBibleBundle(ctx, bookId, bomb, {}, clean));
        expect(refused.problems).toEqual([{ path: 'theme/bomb.md', reason: 'ENTRY_TOO_LARGE' }]);
    });
});

describe('sanitised on the way in', () => {
    it('strips script from rich text and markup from plain text, as a manual save does', async () => {
        const book = await createBook(ctx, { title: 'Sanitised' });
        const report = await importBibleBundle(
            ctx,
            book.id,
            bundleOf({
                'character/x.md':
                    '---\nkind: CHARACTER\nname: <b>Bold</b> name\nslug: x\nstatus: DRAFT\nsummary: Hello <script>alert(1)</script>world\nfields:\n  speaking_voice: <p onclick="x()">Kept<script>alert(1)</script></p>\n  role: "&lt;i&gt;Lead&lt;/i&gt;"\n---\n',
            }),
            {},
            clean,
        );
        const el = await getElement(ctx, book.id, report.items[0].id);
        expect(el.name).toBe('Bold name');
        expect(el.summary).toBe('Hello world');
        expect(el.fields.find((f) => f.key === 'speaking_voice')?.value).toBe('<p>Kept</p>');
        expect(el.fields.find((f) => f.key === 'role')?.value).toBe('Lead');
    });
});

describe('the virus scan', () => {
    const scanEnv = { mode: process.env.AV_SCAN_MODE, host: process.env.CLAMAV_HOST };
    afterEach(() => {
        process.env.AV_SCAN_MODE = scanEnv.mode;
        process.env.CLAMAV_HOST = scanEnv.host;
        if (scanEnv.mode === undefined) delete process.env.AV_SCAN_MODE;
        if (scanEnv.host === undefined) delete process.env.CLAMAV_HOST;
    });

    it('scans the upload’s raw bytes, before anything is unpacked or parsed', async () => {
        const book = await createBook(ctx, { title: 'Scanned first' });
        const seen: Buffer[] = [];
        const spy: ImportDeps = {
            scan: async (bytes) => {
                seen.push(Buffer.from(bytes));
                return { status: 'INFECTED', threat: 'Eicar-Test-Signature', engine: 'test', durationMs: 0 };
            },
        };
        // Not a zip at all: a scan after the unpacking would answer NOT_A_ZIP.
        const upload = new TextEncoder().encode('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
        expect(await refusalOf(importBibleBundle(ctx, book.id, upload, {}, spy))).toMatchObject({ status: 400, reason: 'UPLOAD_INFECTED' });
        expect(seen).toHaveLength(1);
        expect(seen[0].equals(Buffer.from(upload))).toBe(true);
    });

    it('refuses an infected upload, writing nothing', async () => {
        const book = await createBook(ctx, { title: 'Infected' });
        const zip = bundleOf({ 'theme/a.md': '---\nkind: THEME\nname: A\nslug: a\nstatus: DRAFT\n---\n' });
        expect(await refusalOf(importBibleBundle(ctx, book.id, zip, {}, infected))).toMatchObject({ status: 400, reason: 'UPLOAD_INFECTED' });
        expect(await refusalOf(importConceptNote(ctx, book.id, { text: 'Some note' }, infected))).toMatchObject({ status: 400, reason: 'UPLOAD_INFECTED' });
        expect(await prisma.bibleElement.count({ where: { bookId: book.id } })).toBe(0);
    });

    it('fails closed in strict mode when no scanner is reachable, and lets the upload through in permissive mode', async () => {
        const book = await createBook(ctx, { title: 'Unscanned' });
        const zip = bundleOf({ 'theme/a.md': '---\nkind: THEME\nname: A\nslug: a\nstatus: DRAFT\n---\n' });
        delete process.env.CLAMAV_HOST;
        process.env.AV_SCAN_MODE = 'strict';
        expect(await refusalOf(importBibleBundle(ctx, book.id, zip))).toMatchObject({ status: 503, reason: 'SCAN_UNAVAILABLE' });
        expect(await prisma.bibleElement.count({ where: { bookId: book.id } })).toBe(0);
        process.env.AV_SCAN_MODE = 'permissive';
        expect((await importBibleBundle(ctx, book.id, zip)).elements.created).toBe(1);
    });
});

describe('isolation and permission', () => {
    it('reaches only the caller’s workspace: another workspace’s book is not found, and its elements are untouched', async () => {
        const other = await createAccount({ workspaceName: 'Elsewhere' });
        const octx = workspaceCtx(other);
        const theirBook = await createBook(octx, { title: 'Theirs' });
        await createElement(octx, theirBook.id, { kind: 'THEME', name: 'Same slug', slug: 'a' });
        const zip = bundleOf({ 'theme/a.md': '---\nkind: THEME\nname: Mine\nslug: a\nstatus: DRAFT\n---\n' });

        await expect(importBibleBundle(ctx, theirBook.id, zip, {}, clean)).rejects.toBeInstanceOf(NotFoundError);
        await expect(exportBibleBundle(ctx, theirBook.id)).rejects.toBeInstanceOf(NotFoundError);
        await expect(importConceptNote(ctx, theirBook.id, { text: 'x' }, clean)).rejects.toBeInstanceOf(NotFoundError);

        // The same slug in my own book is mine alone.
        const mine = await createBook(ctx, { title: 'Mine' });
        expect((await importBibleBundle(ctx, mine.id, zip, {}, clean)).elements.created).toBe(1);
        const theirs = await listElements(octx, theirBook.id);
        expect(theirs.map((e) => e.name)).toEqual(['Same slug']);
    });

    it('a READER may export but not import', async () => {
        const reader = await createBareUser();
        await addMember(owner.workspaceId, reader.id, 'READER');
        const rctx = workspaceCtx({ userId: reader.id, workspaceId: owner.workspaceId, workspaceSlug: owner.workspaceSlug }, 'READER');
        const book = await createBook(ctx, { title: 'Read only' });
        await createElement(ctx, book.id, { kind: 'THEME', name: 'Debt' });
        const bundle = await exportBibleBundle(rctx, book.id);
        await expect(importBibleBundle(rctx, book.id, bundle.bytes, {}, clean)).rejects.toBeInstanceOf(ForbiddenError);
        await expect(importConceptNote(rctx, book.id, { text: 'x' }, clean)).rejects.toBeInstanceOf(ForbiddenError);
        expect(await versionsOf(book.id)).toBe(1);
    });
});

describe('the concept note', () => {
    it('becomes a RESEARCH element with the text in its notes, versioned IMPORT, and is idempotent per slug', async () => {
        const book = await createBook(ctx, { title: 'Concepts' });
        const text = 'The Salt Roads\n\nA ferrywoman crosses a drowned country.\nShe owes a debt <script>x</script> & more.';
        const first = await importConceptNote(ctx, book.id, { text }, clean);
        expect(first).toMatchObject({ outcome: 'created', versionNumber: 1, element: { kind: 'RESEARCH', name: 'The Salt Roads', slug: 'the-salt-roads' } });
        const el = await getElement(ctx, book.id, first.element.id);
        expect(el.kind).toBe('RESEARCH');
        expect(el.fields.find((f) => f.key === 'notes')?.value).toBe('<p>The Salt Roads</p><p>A ferrywoman crosses a drowned country.<br />She owes a debt  &amp; more.</p>');
        expect((await getVersion(ctx, book.id, el.id, 1)).source).toBe('IMPORT');

        const again = await importConceptNote(ctx, book.id, { text }, clean);
        expect(again).toMatchObject({ outcome: 'unchanged', versionNumber: null, element: { id: el.id } });

        const changed = await importConceptNote(ctx, book.id, { text: `${text}\n\nA third paragraph.` }, clean);
        expect(changed).toMatchObject({ outcome: 'updated', versionNumber: 2, element: { id: el.id } });
        expect((await getVersion(ctx, book.id, el.id, 2)).source).toBe('IMPORT');

        const named = await importConceptNote(ctx, book.id, { text: 'Other', name: 'Pitch', slug: 'pitch' }, clean);
        expect(named).toMatchObject({ outcome: 'created', element: { name: 'Pitch', slug: 'pitch' } });
    });

    it('answers a note its markup would take past the rich-text bound as too long, the reason the modal words', async () => {
        const book = await createBook(ctx, { title: 'Marked up' });
        // 40,000 characters, within the note's bound; a <br /> per line takes
        // its paragraphs past the rich-text field's.
        const text = 'ab\n'.repeat(13_000).trim();
        expect(text.length).toBeLessThan(50_000);
        expect(await refusalOf(importConceptNote(ctx, book.id, { text }, clean))).toMatchObject({ status: 400, reason: 'TOO_LONG' });
        expect(await prisma.bibleElement.count({ where: { bookId: book.id } })).toBe(0);
    });

    it('refuses a slug another kind holds, and an empty or over-long note', async () => {
        const book = await createBook(ctx, { title: 'Concept refusals' });
        await createElement(ctx, book.id, { kind: 'THEME', name: 'Pitch', slug: 'pitch' });
        expect(await refusalOf(importConceptNote(ctx, book.id, { text: 'x', slug: 'pitch' }, clean))).toMatchObject({ status: 409, reason: 'KIND_CONFLICT' });
        expect(await refusalOf(importConceptNote(ctx, book.id, { text: '<b></b>' }, clean))).toMatchObject({ status: 400, reason: 'EMPTY' });
        expect((await refusalOf(importConceptNote(ctx, book.id, { text: 'x'.repeat(50_001) }, clean))).reason).toBe('TOO_LONG');
    });
});

describe('the PDF export and the audit trail', () => {
    it('writes a PDF naming every element, and audit rows that carry counts, never text', async () => {
        const { book } = await seedRichBook('Audited');
        const pdf = await exportBiblePdf(ctx, book.id);
        expect(pdf.contentType).toBe('application/pdf');
        const text = pdfText(pdf.bytes);
        for (const name of ['Audited', 'Mara Vell', 'Tam Vell', 'The Salt Guild', 'Tide tables (Almanac)', 'Old almanac (Almanac)', 'Transfer desk']) expect([name, text.includes(name)]).toEqual([name, true]);

        const target = await createBook(ctx, { title: 'Audit target' });
        await importBibleBundle(ctx, target.id, (await exportBibleBundle(ctx, book.id)).bytes, {}, clean);
        await importConceptNote(ctx, target.id, { text: 'A secret concept' }, clean);
        const rows = await prisma.auditLog.findMany({
            where: { workspaceId: owner.workspaceId, action: { in: ['BIBLE_EXPORTED', 'BIBLE_BUNDLE_IMPORTED', 'BIBLE_CONCEPT_NOTE_IMPORTED'] } },
            select: { action: true, detailsJson: true },
        });
        expect(new Set(rows.map((r) => r.action))).toEqual(new Set(['BIBLE_EXPORTED', 'BIBLE_BUNDLE_IMPORTED', 'BIBLE_CONCEPT_NOTE_IMPORTED']));
        const all = JSON.stringify(rows.map((r) => r.detailsJson));
        for (const secret of ['Mara', 'ferrywoman', 'secret concept', 'Salt']) expect([secret, all.includes(secret)]).toEqual([secret, false]);
        const imported = rows.find((r) => r.action === 'BIBLE_BUNDLE_IMPORTED')!.detailsJson as Record<string, unknown>;
        expect(imported).toMatchObject({ elementsCreated: 5, versionsWritten: 5, relationsCreated: 3 });
    });
});

describe('updateElementFields still versions MANUAL after an import', () => {
    it('keeps the sources apart', async () => {
        const book = await createBook(ctx, { title: 'Sources' });
        const report = await importBibleBundle(ctx, book.id, bundleOf({ 'theme/a.md': '---\nkind: THEME\nname: A\nslug: a\nstatus: DRAFT\n---\n' }), {}, clean);
        const id = report.items[0].id;
        const saved = await updateElementFields(ctx, book.id, id, { fields: [{ key: 'subject', value: 'Debts compound' }] });
        expect((await getVersion(ctx, book.id, id, saved.versionNumber)).source).toBe('MANUAL');
    });
});
