/**
 * Bible versioning against a real database (Phase 1.1).
 *
 *   - every save that changes an element or its fields writes EXACTLY one
 *     version, in the same transaction; a save that changes nothing, and a
 *     save that is refused, write none;
 *   - concurrent saves of one element get distinct, consecutive numbers, and
 *     each snapshot is the state its own save left;
 *   - a restore applies an old snapshot as a NEW version equal to it, leaving
 *     the history before it untouched;
 *   - the version table is append-only in the database: UPDATE, DELETE and
 *     TRUNCATE are refused for the owner and for app_user, except the delete
 *     its book's cascade makes and the clearing of a deleted author.
 */
import { prisma } from '@/lib/db';
import { runInWorkspaceContext } from '@/lib/db/rls-middleware';
import { createElement, deleteElement, getElement, updateElement, updateElementFields } from '@/app-layer/usecases/bible-elements';
import { getVersion, listVersions, restoreVersion } from '@/app-layer/usecases/bible-versions';
import { createBook, deleteBook } from '@/app-layer/usecases/books';
import { ValidationError } from '@/lib/errors/types';
import { addMember, createAccount, createBareUser, workspaceCtx } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

let owner: Awaited<ReturnType<typeof createAccount>>;
let ctx: ReturnType<typeof workspaceCtx>;
let bookId: string;

beforeAll(async () => {
    owner = await createAccount();
    ctx = workspaceCtx(owner);
    bookId = (await createBook(ctx, { title: 'Versioned book' })).id;
});

const versionCount = (elementId: string) => prisma.bibleEntryVersion.count({ where: { elementId } });

async function newCharacter(name = 'Mara') {
    return createElement(ctx, bookId, { kind: 'CHARACTER', name, fields: [{ key: 'role', value: 'Lead' }] });
}

describe('one version per save', () => {
    it('creating an element writes version 1, holding the element and its fields', async () => {
        const el = await newCharacter();
        expect(await versionCount(el.id)).toBe(1);
        const v1 = await getVersion(ctx, bookId, el.id, 1);
        expect(v1.source).toBe('MANUAL');
        expect(v1.authorId).toBe(owner.userId);
        expect(v1.snapshot.element).toEqual({ kind: 'CHARACTER', name: 'Mara', slug: el.slug, status: 'DRAFT', summary: null, customLabel: null });
        expect(v1.snapshot.fields).toEqual([{ key: 'role', order: 1, value: 'Lead' }]);
    });

    it('each changing save adds exactly one; a save that changes nothing adds none', async () => {
        const el = await newCharacter();
        await updateElement(ctx, bookId, el.id, { summary: 'A ferrywoman' });
        expect(await versionCount(el.id)).toBe(2);
        const saved = await updateElementFields(ctx, bookId, el.id, { fields: [{ key: 'want', value: 'To cross' }, { key: 'agency', value: 4 }] });
        expect(saved.changedKeys.sort()).toEqual(['agency', 'want']);
        expect(saved.versionNumber).toBe(3);
        expect(await versionCount(el.id)).toBe(3);

        const again = await updateElementFields(ctx, bookId, el.id, { fields: [{ key: 'want', value: 'To cross' }] });
        expect(again.changedKeys).toEqual([]);
        await updateElement(ctx, bookId, el.id, { summary: 'A ferrywoman' });
        expect(await versionCount(el.id)).toBe(3);

        const v3 = await getVersion(ctx, bookId, el.id, 3);
        expect(v3.snapshot.element.summary).toBe('A ferrywoman');
        expect(v3.snapshot.fields).toEqual([
            { key: 'role', order: 1, value: 'Lead' },
            { key: 'want', order: 6, value: 'To cross' },
            { key: 'agency', order: 8, value: 4 },
        ]);
    });

    it('clearing a field is a save: its row goes and the next snapshot omits it', async () => {
        const el = await newCharacter();
        await updateElementFields(ctx, bookId, el.id, { fields: [{ key: 'role', value: null }] });
        expect(await prisma.bibleField.count({ where: { elementId: el.id } })).toBe(0);
        expect((await getVersion(ctx, bookId, el.id, 2)).snapshot.fields).toEqual([]);
    });

    it('a refused save writes nothing at all, version included', async () => {
        const el = await newCharacter();
        await expect(
            updateElementFields(ctx, bookId, el.id, { fields: [{ key: 'want', value: 'fine' }, { key: 'agency', value: 9 }] }),
        ).rejects.toBeInstanceOf(ValidationError);
        expect(await versionCount(el.id)).toBe(1);
        expect((await getElement(ctx, bookId, el.id)).fields.find((f) => f.key === 'want')?.value).toBeNull();
    });
});

describe('concurrent saves', () => {
    it('get distinct, consecutive numbers, each snapshot holding the state its own save left', async () => {
        const el = await newCharacter('Racer');
        const N = 6;
        const results = await Promise.all(
            Array.from({ length: N }, (_v, i) => updateElementFields(ctx, bookId, el.id, { fields: [{ key: 'want', value: `want ${i}` }] })),
        );
        const numbers = results.map((r) => r.versionNumber).sort((a, b) => a - b);
        expect(numbers).toEqual(Array.from({ length: N }, (_v, i) => i + 2));
        const rows = await prisma.bibleEntryVersion.findMany({ where: { elementId: el.id }, select: { versionNumber: true } });
        expect(rows.map((r) => r.versionNumber).sort((a, b) => a - b)).toEqual(Array.from({ length: N + 1 }, (_v, i) => i + 1));

        // Each save returned the state after its own write, which is its version's snapshot.
        for (const r of results) {
            const want = r.fields.find((f) => f.key === 'want')?.value;
            expect((await getVersion(ctx, bookId, el.id, r.versionNumber)).snapshot.fields.find((f) => f.key === 'want')?.value).toBe(want);
        }
        // The last version is the element as it stands.
        const latest = await getVersion(ctx, bookId, el.id, N + 1);
        const now = await getElement(ctx, bookId, el.id);
        expect(latest.snapshot.fields.find((f) => f.key === 'want')?.value).toBe(now.fields.find((f) => f.key === 'want')?.value);
    });

    it('the unique index refuses a duplicate number whoever writes', async () => {
        const el = await newCharacter();
        const v1 = await prisma.bibleEntryVersion.findFirstOrThrow({ where: { elementId: el.id } });
        await expect(
            prisma.bibleEntryVersion.create({
                data: { ...v1, id: undefined, createdAt: undefined, snapshot: '{}', changeSummary: null } as never,
            }),
        ).rejects.toThrow(/Unique constraint|unique/i);
    });
});

describe('restore', () => {
    it('creates a new version equal to the old snapshot and leaves the history before it untouched', async () => {
        const el = await newCharacter('Orla');
        await updateElementFields(ctx, bookId, el.id, { fields: [{ key: 'want', value: 'v2 want' }, { key: 'defining_traits', value: ['wry'] }] });
        await updateElement(ctx, bookId, el.id, { name: 'Orla Vane', status: 'SETTLED', summary: 'later' });
        const before = await prisma.bibleEntryVersion.findMany({ where: { elementId: el.id }, orderBy: { versionNumber: 'asc' } });
        expect(before).toHaveLength(3);

        const result = await restoreVersion(ctx, bookId, el.id, 1);
        expect(result.version.versionNumber).toBe(4);
        expect(result.version.restoredFromVersion).toBe(1);
        expect(result.skippedFieldKeys).toEqual([]);

        const v1 = await getVersion(ctx, bookId, el.id, 1);
        const v4 = await getVersion(ctx, bookId, el.id, 4);
        expect(v4.snapshot).toEqual(v1.snapshot);
        const now = await getElement(ctx, bookId, el.id);
        expect(now.name).toBe('Orla');
        expect(now.status).toBe('DRAFT');
        expect(now.fields.filter((f) => f.value !== null).map((f) => [f.key, f.value])).toEqual([['role', 'Lead']]);

        // Versions 1–3 are byte for byte what they were.
        const after = await prisma.bibleEntryVersion.findMany({ where: { elementId: el.id, versionNumber: { lte: 3 } }, orderBy: { versionNumber: 'asc' } });
        expect(after).toEqual(before);
    });

    it('keeps the current slug when another element has taken the old one since', async () => {
        const el = await newCharacter('Pell');
        const oldSlug = el.slug;
        await updateElement(ctx, bookId, el.id, { slug: 'pell-renamed' });
        await createElement(ctx, bookId, { kind: 'SETTING', name: 'Usurper', slug: oldSlug });
        const result = await restoreVersion(ctx, bookId, el.id, 1);
        expect(result.slugKept).toBe(true);
        expect((await getElement(ctx, bookId, el.id)).slug).toBe('pell-renamed');
    });

    it('refuses a version number the element does not have', async () => {
        const el = await newCharacter();
        await expect(restoreVersion(ctx, bookId, el.id, 7)).rejects.toThrow(/Version not found/);
    });
});

describe('listing', () => {
    it('is newest first, without snapshots, and pages with `before`', async () => {
        const el = await newCharacter();
        for (const v of ['a', 'b', 'c']) await updateElementFields(ctx, bookId, el.id, { fields: [{ key: 'want', value: v }] });
        const page = await listVersions(ctx, bookId, el.id, { take: 2 });
        expect(page.map((v) => v.versionNumber)).toEqual([4, 3]);
        expect(page[0]).not.toHaveProperty('snapshot');
        expect((await listVersions(ctx, bookId, el.id, { before: 3 })).map((v) => v.versionNumber)).toEqual([2, 1]);
    });
});

describe('append-only in the database', () => {
    const REFUSED = /BIBLE_VERSION_APPEND_ONLY|permission denied/;

    it('the owner (a superuser here) cannot update, delete or truncate a version', async () => {
        const el = await newCharacter();
        await expect(prisma.$executeRaw`UPDATE "BibleEntryVersion" SET "versionNumber" = 99 WHERE "elementId" = ${el.id}`).rejects.toThrow(
            /BIBLE_VERSION_APPEND_ONLY/,
        );
        await expect(prisma.$executeRaw`UPDATE "BibleEntryVersion" SET "authorId" = NULL WHERE "elementId" = ${el.id}`).rejects.toThrow(
            /BIBLE_VERSION_APPEND_ONLY/,
        );
        await expect(prisma.bibleEntryVersion.deleteMany({ where: { elementId: el.id } })).rejects.toThrow(/BIBLE_VERSION_APPEND_ONLY/);
        await expect(prisma.$executeRawUnsafe('TRUNCATE "BibleEntryVersion"')).rejects.toThrow(/BIBLE_VERSION_APPEND_ONLY/);
        expect(await versionCount(el.id)).toBe(1);
    });

    it('app_user holds no UPDATE or DELETE on it', async () => {
        const el = await newCharacter();
        await expect(
            runInWorkspaceContext(ctx, (db) => db.$executeRaw`UPDATE "BibleEntryVersion" SET "versionNumber" = 99 WHERE "elementId" = ${el.id}`),
        ).rejects.toThrow(REFUSED);
        await expect(runInWorkspaceContext(ctx, (db) => db.$executeRaw`DELETE FROM "BibleEntryVersion" WHERE "elementId" = ${el.id}`)).rejects.toThrow(REFUSED);
        expect(await versionCount(el.id)).toBe(1);
    });

    it("an element's deletion keeps its history; its book's deletion (by app_user) takes the history with it", async () => {
        const book = await createBook(ctx, { title: 'Doomed' });
        const el = await createElement(ctx, book.id, { kind: 'THEME', name: 'Loss' });
        await updateElement(ctx, book.id, el.id, { summary: 'grief' });
        await deleteElement(ctx, book.id, el.id);
        expect(await versionCount(el.id)).toBe(2);
        await deleteBook(ctx, book.id);
        expect(await versionCount(el.id)).toBe(0);
        expect(await prisma.book.findUnique({ where: { id: book.id } })).toBeNull();
    });

    it("a workspace's deletion takes its versions with it", async () => {
        const other = await createAccount();
        const octx = workspaceCtx(other);
        const book = await createBook(octx, { title: 'Gone with the desk' });
        await createElement(octx, book.id, { kind: 'MOOD', name: 'Dread' });
        expect(await prisma.bibleEntryVersion.count({ where: { bookId: book.id } })).toBe(1);
        await prisma.workspace.delete({ where: { id: other.workspaceId } });
        expect(await prisma.bibleEntryVersion.count({ where: { bookId: book.id } })).toBe(0);
    });

    it("deleting an author's account clears authorId and keeps the version", async () => {
        const editor = await createBareUser();
        await addMember(owner.workspaceId, editor.id, 'EDITOR');
        const ectx = { ...workspaceCtx(owner, 'EDITOR'), userId: editor.id };
        const el = await createElement(ectx, bookId, { kind: 'OBJECT', name: 'Lamp', fields: [{ key: 'physical_description', value: 'brass' }] });
        expect((await prisma.bibleEntryVersion.findFirstOrThrow({ where: { elementId: el.id } })).authorId).toBe(editor.id);
        await prisma.user.delete({ where: { id: editor.id } });
        const kept = await prisma.bibleEntryVersion.findFirstOrThrow({ where: { elementId: el.id } });
        expect(kept.authorId).toBeNull();
        expect((await getVersion(ctx, bookId, el.id, 1)).snapshot.fields).toEqual([{ key: 'physical_description', order: 1, value: 'brass' }]);
    });
});
