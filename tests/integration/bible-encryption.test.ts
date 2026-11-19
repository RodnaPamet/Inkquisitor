/**
 * The bible's author text is encrypted at rest (Phase 1.1, roadmap rule 4).
 *
 * For EVERY column of the shipped manifest (`ENCRYPTED_FIELDS`, so a column
 * added there is covered here the day it is added): the value written through
 * the usecases is a `v2:` envelope in the database with no trace of the
 * plaintext, and reads back as the plaintext in its own workspace. The
 * snapshot — a JSON document — is sealed whole as one string and round-trips
 * to the same structure. A ciphertext read under another workspace's key is
 * refused loudly. The readable columns (title, name, slug) stay readable.
 */
import { prisma } from '@/lib/db';
import { runWithDbContext } from '@/lib/db/db-context';
import { DecryptIntegrityError } from '@/lib/db/encryption-middleware';
import { ENCRYPTED_FIELDS } from '@/lib/security/encrypted-fields';
import { createElement, getElement } from '@/app-layer/usecases/bible-elements';
import { addRelation } from '@/app-layer/usecases/bible-relations';
import { getVersion } from '@/app-layer/usecases/bible-versions';
import { createBook, getBook } from '@/app-layer/usecases/books';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

// Built at run time, so no literal here reads as the stored value.
const MARK = ['quill', 'mark', Date.now().toString(36)].join('-');

let a: Awaited<ReturnType<typeof createAccount>>;
let b: Awaited<ReturnType<typeof createAccount>>;
let ctx: ReturnType<typeof workspaceCtx>;
const ids: Record<string, string> = {};

beforeAll(async () => {
    a = await createAccount();
    b = await createAccount();
    ctx = workspaceCtx(a);
    const book = await createBook(ctx, { title: 'Plain title', logline: `logline ${MARK}` });
    const el = await createElement(ctx, book.id, {
        kind: 'CHARACTER',
        name: 'Plain name',
        summary: `summary ${MARK}`,
        fields: [
            { key: 'want', value: `want ${MARK}` },
            { key: 'defining_traits', value: [`trait ${MARK}`] },
            { key: 'wound', value: `<p>wound ${MARK}</p>` },
        ],
        changeSummary: `change ${MARK}`,
    });
    const other = await createElement(ctx, book.id, { kind: 'FACTION', name: 'Plain faction' });
    const rel = await addRelation(ctx, book.id, { fromElementId: el.id, toElementId: other.id, type: 'member_of', note: `note ${MARK}` });
    Object.assign(ids, { Book: book.id, BibleElement: el.id, BibleRelation: rel.id });
});

/** The raw stored values of `field` on every row of `model` this suite wrote, read as the owner. */
async function rawValues(model: string, field: string): Promise<string[]> {
    const where =
        model === 'BibleField' || model === 'BibleEntryVersion' ? `"elementId" = $1` : `"id" = $1`;
    const id = model === 'BibleField' || model === 'BibleEntryVersion' ? ids.BibleElement : ids[model];
    const rows = await prisma.$queryRawUnsafe<Array<{ v: string | null }>>(`SELECT "${field}" AS v FROM "${model}" WHERE ${where}`, id);
    return rows.map((r) => r.v).filter((v): v is string => v !== null);
}

const manifest = Object.entries(ENCRYPTED_FIELDS).flatMap(([model, fields]) => fields.map((field) => [model, field] as const));

it('the manifest covers the bible author text the brief names', () => {
    expect(manifest.map(([m, f]) => `${m}.${f}`).sort()).toEqual(
        ['BibleElement.summary', 'BibleEntryVersion.changeSummary', 'BibleEntryVersion.snapshot', 'BibleField.value', 'BibleRelation.note', 'Book.logline'].sort(),
    );
});

it.each(manifest)('%s.%s is a v2 envelope at rest with no trace of the plaintext', async (model, field) => {
    const values = await rawValues(model, field);
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) {
        expect(v).toMatch(/^v2:/);
        expect(v).not.toContain(MARK);
    }
});

it('reads back as plaintext in its own workspace', async () => {
    expect((await getBook(ctx, ids.Book)).logline).toBe(`logline ${MARK}`);
    const el = await getElement(ctx, ids.Book, ids.BibleElement);
    expect(el.summary).toBe(`summary ${MARK}`);
    expect(el.fields.find((f) => f.key === 'want')?.value).toBe(`want ${MARK}`);
    expect(el.fields.find((f) => f.key === 'defining_traits')?.value).toEqual([`trait ${MARK}`]);
    expect(el.relations[0].note).toBe(`note ${MARK}`);
});

it('the snapshot is sealed whole and round-trips to the same structure', async () => {
    const v1 = await getVersion(ctx, ids.Book, ids.BibleElement, 1);
    expect(v1.changeSummary).toBe(`change ${MARK}`);
    expect(v1.snapshot.element.summary).toBe(`summary ${MARK}`);
    expect(v1.snapshot.fields).toEqual([
        { key: 'defining_traits', order: 3, value: [`trait ${MARK}`] },
        { key: 'want', order: 6, value: `want ${MARK}` },
        { key: 'wound', order: 9, value: `<p>wound ${MARK}</p>` },
    ]);
});

it("another workspace's key refuses the ciphertext loudly", async () => {
    await expect(
        runWithDbContext({ workspaceId: b.workspaceId, source: 'test' }, () => prisma.bibleField.findFirst({ where: { elementId: ids.BibleElement } })),
    ).rejects.toBeInstanceOf(DecryptIntegrityError);
});

it('titles, names and slugs stay readable (they are sorted and keyed on)', async () => {
    const [book] = await prisma.$queryRaw<Array<{ title: string }>>`SELECT "title" FROM "Book" WHERE "id" = ${ids.Book}`;
    const [el] = await prisma.$queryRaw<Array<{ name: string; slug: string }>>`SELECT "name", "slug" FROM "BibleElement" WHERE "id" = ${ids.BibleElement}`;
    expect(book.title).toBe('Plain title');
    expect(el).toEqual({ name: 'Plain name', slug: 'plain-name' });
});
