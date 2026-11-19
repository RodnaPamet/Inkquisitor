/**
 * The bible between two workspaces (Phase 1.1).
 *
 * Workspace A's owner, through every bible usecase, cannot read or change
 * anything of workspace B's: books, elements, fields, relations, versions.
 * Below the usecases, the app role bound to A sees none of B's rows in any
 * bible table and cannot update, delete or insert them; and the composite
 * foreign keys refuse a row that would hang off another workspace's book or
 * tie two books together, whoever writes it.
 *
 * The policy structure and the generic per-table probe are
 * tests/integration/rls-coverage.test.ts, which covers the bible tables too.
 */
import { prisma } from '@/lib/db';
import { runInWorkspaceContext } from '@/lib/db/rls-middleware';
import { createElement, deleteElement, getElement, listElements, updateElement, updateElementFields } from '@/app-layer/usecases/bible-elements';
import { addRelation, removeRelation } from '@/app-layer/usecases/bible-relations';
import { getVersion, listVersions, restoreVersion } from '@/app-layer/usecases/bible-versions';
import { createBook, deleteBook, getBook, listBooks, updateBook } from '@/app-layer/usecases/books';
import { NotFoundError } from '@/lib/errors/types';
import { seedBible, type SeededBible } from '../helpers/bible';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

let a: Awaited<ReturnType<typeof createAccount>>;
let b: Awaited<ReturnType<typeof createAccount>>;
let aBible: SeededBible;
let bBible: SeededBible;
let actx: ReturnType<typeof workspaceCtx>;

beforeAll(async () => {
    a = await createAccount({ workspaceName: 'Bible A' });
    b = await createAccount({ workspaceName: 'Bible B' });
    actx = workspaceCtx(a);
    aBible = await seedBible(actx, 'iso-a');
    bBible = await seedBible(workspaceCtx(b), 'iso-b');
});

/** Everything of B's, read as the owner (who sees all), to prove nothing moved. */
async function bState() {
    const ws = { workspaceId: b.workspaceId };
    return {
        books: await prisma.book.findMany({ where: ws, orderBy: { id: 'asc' } }),
        elements: await prisma.bibleElement.findMany({ where: ws, orderBy: { id: 'asc' } }),
        fields: await prisma.bibleField.findMany({ where: ws, orderBy: { id: 'asc' } }),
        relations: await prisma.bibleRelation.findMany({ where: ws, orderBy: { id: 'asc' } }),
        versions: await prisma.bibleEntryVersion.findMany({ where: ws, orderBy: { id: 'asc' } }),
    };
}

describe("A's owner, through the usecases, reaches nothing of B's", () => {
    it('reads: every lookup of a B id is the same 404 a missing one gets', async () => {
        const b1 = bBible;
        const attempts: Array<() => Promise<unknown>> = [
            () => getBook(actx, b1.bookId),
            () => listElements(actx, b1.bookId),
            () => getElement(actx, b1.bookId, b1.characterId),
            () => getElement(actx, aBible.bookId, b1.characterId),
            () => listVersions(actx, b1.bookId, b1.characterId),
            () => getVersion(actx, b1.bookId, b1.characterId, 1),
            () => getVersion(actx, aBible.bookId, b1.characterId, 1),
        ];
        for (const attempt of attempts) await expect(attempt()).rejects.toBeInstanceOf(NotFoundError);
        expect((await listBooks(actx)).books.map((x) => x.id)).toEqual([aBible.bookId]);
    });

    it('writes: every change aimed at B is refused and B is byte-for-byte unchanged', async () => {
        const before = await bState();
        const b1 = bBible;
        const attempts: Array<() => Promise<unknown>> = [
            () => updateBook(actx, b1.bookId, { title: 'taken' }),
            () => deleteBook(actx, b1.bookId),
            () => createElement(actx, b1.bookId, { kind: 'THEME', name: 'Intrusion' }),
            () => updateElement(actx, b1.bookId, b1.characterId, { name: 'taken', baseVersion: 1 }),
            () => updateElement(actx, aBible.bookId, b1.characterId, { name: 'taken', baseVersion: 1 }),
            () => updateElementFields(actx, b1.bookId, b1.characterId, { fields: [{ key: 'want', value: 'taken' }], baseVersion: 1 }),
            () => updateElementFields(actx, aBible.bookId, b1.characterId, { fields: [{ key: 'want', value: 'taken' }], baseVersion: 1 }),
            () => deleteElement(actx, b1.bookId, b1.characterId),
            () => addRelation(actx, b1.bookId, { fromElementId: b1.characterId, toElementId: b1.factionId, type: 'related_to' }),
            () => addRelation(actx, aBible.bookId, { fromElementId: aBible.characterId, toElementId: b1.factionId, type: 'member_of' }),
            () => removeRelation(actx, b1.bookId, b1.relationId),
            () => removeRelation(actx, aBible.bookId, b1.relationId),
            () => restoreVersion(actx, b1.bookId, b1.characterId, 1, { baseVersion: 1 }),
        ];
        for (const attempt of attempts) await expect(attempt()).rejects.toBeInstanceOf(NotFoundError);
        expect(await bState()).toEqual(before);
    });
});

describe('the app role bound to A, below the usecases', () => {
    const inA = <T>(fn: Parameters<typeof runInWorkspaceContext<T>>[1]) => runInWorkspaceContext(actx, fn);
    const tables = ['Book', 'BibleElement', 'BibleField', 'BibleRelation', 'BibleEntryVersion'] as const;

    it.each(tables)("%s: sees its own rows and none of B's, even through raw SQL", async (table) => {
        const rows = await inA((db) => db.$queryRawUnsafe<Array<{ workspaceId: string }>>(`SELECT "workspaceId" FROM "${table}"`));
        expect(rows.length).toBeGreaterThan(0);
        expect(new Set(rows.map((r) => r.workspaceId))).toEqual(new Set([a.workspaceId]));
    });

    it("updates and deletes aimed at B's rows touch nothing", async () => {
        const before = await bState();
        const counts = await inA(async (db) => [
            (await db.book.updateMany({ where: { id: bBible.bookId }, data: { title: 'taken' } })).count,
            (await db.bibleElement.updateMany({ where: { id: bBible.characterId }, data: { name: 'taken' } })).count,
            (await db.bibleField.deleteMany({ where: { elementId: bBible.characterId } })).count,
            (await db.bibleRelation.deleteMany({ where: { id: bBible.relationId } })).count,
            (await db.bibleElement.deleteMany({ where: { id: bBible.factionId } })).count,
            (await db.book.deleteMany({ where: { id: bBible.bookId } })).count,
        ]);
        expect(counts).toEqual([0, 0, 0, 0, 0, 0]);
        expect(await bState()).toEqual(before);
    });

    it("an insert carrying B's workspaceId is refused, for every table", async () => {
        const attempts: Array<(db: Parameters<Parameters<typeof inA>[0]>[0]) => Promise<unknown>> = [
            (db) => db.book.create({ data: { workspaceId: b.workspaceId, title: 'Forged' } }),
            (db) => db.bibleElement.create({ data: { workspaceId: b.workspaceId, bookId: bBible.bookId, kind: 'THEME', name: 'Forged', slug: 'forged' } }),
            (db) => db.bibleField.create({ data: { workspaceId: b.workspaceId, elementId: bBible.characterId, key: 'need', value: '"x"', order: 12 } }),
            (db) =>
                db.bibleRelation.create({
                    data: { workspaceId: b.workspaceId, bookId: bBible.bookId, fromElementId: bBible.characterId, toElementId: bBible.factionId, type: 'related_to' },
                }),
            (db) =>
                db.bibleEntryVersion.create({
                    data: { workspaceId: b.workspaceId, bookId: bBible.bookId, elementId: bBible.characterId, versionNumber: 99, snapshot: '{}', source: 'MANUAL' },
                }),
        ];
        for (const attempt of attempts) await expect(inA(attempt)).rejects.toThrow(/row-level security|violates/i);
        expect(await prisma.book.count({ where: { workspaceId: b.workspaceId } })).toBe(1);
    });

    it("A cannot hang its own rows off B's book or element (the workspace travels in every foreign key)", async () => {
        const attempts: Array<(db: Parameters<Parameters<typeof inA>[0]>[0]) => Promise<unknown>> = [
            (db) => db.bibleElement.create({ data: { workspaceId: a.workspaceId, bookId: bBible.bookId, kind: 'THEME', name: 'Squatter', slug: 'squatter' } }),
            (db) => db.bibleField.create({ data: { workspaceId: a.workspaceId, elementId: bBible.characterId, key: 'need', value: '"x"', order: 12 } }),
            (db) =>
                db.bibleRelation.create({
                    data: { workspaceId: a.workspaceId, bookId: aBible.bookId, fromElementId: aBible.characterId, toElementId: bBible.factionId, type: 'related_to' },
                }),
            (db) =>
                db.bibleEntryVersion.create({
                    data: { workspaceId: a.workspaceId, bookId: bBible.bookId, elementId: bBible.characterId, versionNumber: 99, snapshot: '{}', source: 'MANUAL' },
                }),
        ];
        for (const attempt of attempts) await expect(inA(attempt)).rejects.toThrow(/foreign key|violates|row-level security/i);
    });
});

describe('two books of one workspace', () => {
    it('a relation between them is refused by the database itself, whoever writes', async () => {
        const other = await createBook(actx, { title: 'Second book' });
        const stranger = await createElement(actx, other.id, { kind: 'FACTION', name: 'Elsewhere' });
        // As the owner (no RLS), on either book: the composite (bookId, elementId) keys refuse it.
        for (const bookId of [aBible.bookId, other.id]) {
            await expect(
                prisma.bibleRelation.create({
                    data: { workspaceId: a.workspaceId, bookId, fromElementId: aBible.characterId, toElementId: stranger.id, type: 'member_of' },
                }),
            ).rejects.toThrow(/foreign key/i);
        }
    });
});
