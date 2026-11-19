/**
 * The bible's lists at size (Phase 1.H, #18): nothing stops silently.
 *
 *   - the element list pages by name with a cursor: every element exactly
 *     once, in order, whatever the size; filtered by kind(s) and a name
 *     fragment (the relation picker's search); a forged cursor is a 400;
 *   - the board's counts and completeness are aggregates over EVERY element,
 *     not over the page it shows;
 *   - a capped read takes one more than the cap and says it was cut: the
 *     books list (`truncated`) and an element's relations (`relationsTruncated`).
 */
import { prisma } from '@/lib/db';
import { BOARD_ENTRIES_PER_KIND, createElement, getBookBoard, getElement, listElements, RELATIONS_SHOWN_MAX } from '@/app-layer/usecases/bible-elements';
import { BOOK_LIST_MAX, createBook, listBooks } from '@/app-layer/usecases/books';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

let owner: Awaited<ReturnType<typeof createAccount>>;
let ctx: ReturnType<typeof workspaceCtx>;
let bookId: string;
const CHARACTERS = Math.max(BOARD_ENTRIES_PER_KIND + 25, 80);

beforeAll(async () => {
    owner = await createAccount();
    ctx = workspaceCtx(owner);
    bookId = (await createBook(ctx, { title: 'A crowded book' })).id;
    // Rows straight in (the superuser; nothing here is author text needing a key): the
    // lists' behaviour at size is the subject, not the create path.
    await prisma.bibleElement.createMany({
        data: Array.from({ length: CHARACTERS }, (_, i) => ({
            workspaceId: owner.workspaceId,
            bookId,
            kind: 'CHARACTER' as const,
            name: `Person ${String(i).padStart(3, '0')}`,
            slug: `person-${i}`,
        })),
    });
    await prisma.bibleElement.createMany({
        data: ['Harbour', 'Hill', 'Moor'].map((name, i) => ({ workspaceId: owner.workspaceId, bookId, kind: 'SETTING' as const, name, slug: `place-${i}` })),
    });
});

describe('the element list', () => {
    it('pages by name with a cursor: every element exactly once, in order', async () => {
        const seen: string[] = [];
        let after: string | undefined;
        let pages = 0;
        do {
            const page = await listElements(ctx, bookId, { take: 20, ...(after ? { after } : {}) });
            seen.push(...page.elements.map((e) => e.name));
            after = page.nextCursor ?? undefined;
            pages++;
        } while (after && pages < 50);
        expect(seen).toHaveLength(CHARACTERS + 3);
        expect(new Set(seen).size).toBe(seen.length);
        expect(seen).toEqual([...seen].sort());
        expect(pages).toBe(Math.ceil((CHARACTERS + 3) / 20));
    });

    it('filters by kinds and a name fragment (the relation picker), and says there is no next page when there is none', async () => {
        const page = await listElements(ctx, bookId, { kinds: ['SETTING', 'FACTION'], q: 'h' });
        expect(page.elements.map((e) => e.name)).toEqual(['Harbour', 'Hill']);
        expect(page.nextCursor).toBeNull();
        const one = await listElements(ctx, bookId, { kind: 'CHARACTER', q: 'person 06', take: 5 });
        expect(one.elements.map((e) => e.name)).toEqual(['Person 060', 'Person 061', 'Person 062', 'Person 063', 'Person 064']);
        expect(one.nextCursor).not.toBeNull();
    });

    it('searches for what the author typed, literally: `%`, `_` and a backslash are characters, not wildcards', async () => {
        const literal = (await createBook(ctx, { title: 'Wildcards' })).id;
        await prisma.bibleElement.createMany({
            data: ['100% sure', 'a_b', 'axb', 'back\\slash', 'plain'].map((name, i) => ({ workspaceId: owner.workspaceId, bookId: literal, kind: 'SETTING' as const, name, slug: `w-${i}` })),
        });
        const names = async (q: string) => (await listElements(ctx, literal, { q })).elements.map((e) => e.name);
        expect(await names('%')).toEqual(['100% sure']);
        expect(await names('a_b')).toEqual(['a_b']);
        expect(await names('\\')).toEqual(['back\\slash']);
        expect(await names('A')).toEqual(['a_b', 'axb', 'back\\slash', 'plain']);
    });

    it('refuses a cursor it did not give, and a page past the maximum', async () => {
        await expect(listElements(ctx, bookId, { after: 'not-a-cursor' })).rejects.toMatchObject({ details: { reason: 'CURSOR_INVALID' } });
        await expect(listElements(ctx, bookId, { take: 201 })).rejects.toThrow();
    });
});

describe('paging when names tie', () => {
    it('the board’s first page and every later page hold each element exactly once, in a stable order, however many share a name', async () => {
        const tied = (await createBook(ctx, { title: 'Twins' })).id;
        // Sixty factions under three names (two differing only in case), across the board's
        // page boundary and every later page boundary: only the id can order them.
        await prisma.bibleElement.createMany({
            data: Array.from({ length: 60 }, (_, i) => ({ workspaceId: owner.workspaceId, bookId: tied, kind: 'FACTION' as const, name: ['Twin', 'twin', 'Twin'][i % 3], slug: `twin-${i}` })),
        });
        const read = async () => {
            const faction = (await getBookBoard(ctx, tied)).find((k) => k.kind === 'FACTION')!;
            const ids = faction.entries.map((e) => e.id);
            for (let after = faction.nextCursor, pages = 0; after && pages < 20; pages++) {
                const page = await listElements(ctx, tied, { kind: 'FACTION', after, take: 7 });
                ids.push(...page.elements.map((e) => e.id));
                after = page.nextCursor;
            }
            return ids;
        };
        const ids = await read();
        expect(ids).toHaveLength(60);
        expect(new Set(ids).size).toBe(60);
        // The same order every time, and the same as one page of all of them.
        expect(await read()).toEqual(ids);
        expect((await listElements(ctx, tied, { kind: 'FACTION', take: 60 })).elements.map((e) => e.id)).toEqual(ids);
    });
});

describe('the board', () => {
    it('counts every element and every filled field by aggregate, and shows the first page of each kind', async () => {
        const [first] = (await listElements(ctx, bookId, { kind: 'CHARACTER', take: 1 })).elements;
        // A field on an element past the board's first page, too: the aggregate still counts it.
        const last = (await listElements(ctx, bookId, { kind: 'CHARACTER', q: `Person ${String(CHARACTERS - 1).padStart(3, '0')}` })).elements[0];
        // Field rows straight in, as the elements were (they have no version for a save to be based on);
        // the board counts keys and decrypts nothing.
        const field = (elementId: string, key: string, order: number) => ({ workspaceId: owner.workspaceId, elementId, key, value: '"x"', order });
        await prisma.bibleField.createMany({ data: [field(first.id, 'role', 1), field(first.id, 'want', 2), field(last.id, 'role', 1)] });
        const board = await getBookBoard(ctx, bookId);
        const character = board.find((k) => k.kind === 'CHARACTER')!;
        expect(character.entryCount).toBe(CHARACTERS);
        expect(character.filledFieldCount).toBe(3);
        expect(character.entries).toHaveLength(BOARD_ENTRIES_PER_KIND);
        expect(character.entries[0].filledFieldCount).toBe(2);
        expect(character.nextCursor).not.toBeNull();
        const next = await listElements(ctx, bookId, { kind: 'CHARACTER', after: character.nextCursor! });
        expect(next.elements).toHaveLength(CHARACTERS - BOARD_ENTRIES_PER_KIND);
        expect(next.elements.at(-1)!.filledFieldCount).toBe(1);
        const setting = board.find((k) => k.kind === 'SETTING')!;
        expect([setting.entryCount, setting.entries.length, setting.nextCursor]).toEqual([3, 3, null]);
        // Every kind is present, the empty ones as zero: "not started", never a percentage.
        expect(board.find((k) => k.kind === 'THEME')).toEqual({ kind: 'THEME', entryCount: 0, filledFieldCount: 0, entries: [], nextCursor: null });
        expect(board).toHaveLength(15);
    });

    it('a key no longer in the template is not counted (keys only; nothing decrypted)', async () => {
        const el = await createElement(ctx, bookId, { kind: 'THEME', name: 'Stale key' });
        await prisma.bibleField.create({ data: { workspaceId: owner.workspaceId, elementId: el.id, key: 'retired_key', value: '"x"', order: 99 } });
        expect((await getBookBoard(ctx, bookId)).find((k) => k.kind === 'THEME')!.filledFieldCount).toBe(0);
    });
});

describe('capped reads say they were cut', () => {
    it('the books list reads one past its cap', async () => {
        const other = await createAccount();
        const octx = workspaceCtx(other);
        await prisma.book.createMany({ data: Array.from({ length: BOOK_LIST_MAX }, (_, i) => ({ workspaceId: other.workspaceId, title: `Book ${i}` })) });
        expect(await listBooks(octx)).toMatchObject({ truncated: false });
        await prisma.book.create({ data: { workspaceId: other.workspaceId, title: 'One too many' } });
        const list = await listBooks(octx);
        expect(list.books).toHaveLength(BOOK_LIST_MAX);
        expect(list.truncated).toBe(true);
    });

    it('an element reads one relation past its cap', async () => {
        const hub = await createElement(ctx, bookId, { kind: 'SETTING', name: 'Hub' });
        const others = await prisma.bibleElement.createManyAndReturn({
            data: Array.from({ length: RELATIONS_SHOWN_MAX + 1 }, (_, i) => ({ workspaceId: owner.workspaceId, bookId, kind: 'OBJECT' as const, name: `Thing ${i}`, slug: `thing-${i}` })),
            select: { id: true },
        });
        const relate = (ids: Array<{ id: string }>) =>
            prisma.bibleRelation.createMany({ data: ids.map(({ id }) => ({ workspaceId: owner.workspaceId, bookId, fromElementId: hub.id, toElementId: id, type: 'related_to', symmetric: true })) });
        await relate(others.slice(0, RELATIONS_SHOWN_MAX));
        expect(await getElement(ctx, bookId, hub.id)).toMatchObject({ relationsTruncated: false });
        await relate(others.slice(RELATIONS_SHOWN_MAX));
        const view = await getElement(ctx, bookId, hub.id);
        expect(view.relations).toHaveLength(RELATIONS_SHOWN_MAX);
        expect(view.relationsTruncated).toBe(true);
    });
});
