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
import { BOARD_ENTRIES_PER_KIND, createElement, getBookBoard, getElement, listElements, RELATIONS_SHOWN_MAX, updateElementFields } from '@/app-layer/usecases/bible-elements';
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

    it('refuses a cursor it did not give, and a page past the maximum', async () => {
        await expect(listElements(ctx, bookId, { after: 'not-a-cursor' })).rejects.toMatchObject({ details: { reason: 'CURSOR_INVALID' } });
        await expect(listElements(ctx, bookId, { take: 201 })).rejects.toThrow();
    });
});

describe('the board', () => {
    it('counts every element and every filled field by aggregate, and shows the first page of each kind', async () => {
        const [first] = (await listElements(ctx, bookId, { kind: 'CHARACTER', take: 1 })).elements;
        // A field on an element past the board's first page, too: the aggregate still counts it.
        const last = (await listElements(ctx, bookId, { kind: 'CHARACTER', q: `Person ${String(CHARACTERS - 1).padStart(3, '0')}` })).elements[0];
        await updateElementFields(ctx, bookId, first.id, { fields: [{ key: 'role', value: 'Lead' }, { key: 'want', value: 'Home' }] });
        await updateElementFields(ctx, bookId, last.id, { fields: [{ key: 'role', value: 'Extra' }] });
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
