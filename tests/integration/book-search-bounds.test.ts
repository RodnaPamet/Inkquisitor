/**
 * Word search's read bounds (Phase 3.4), with the limits shrunk
 * (`searchBook`'s `limits`) so a small book crosses them: the elements read by name, the fields read a chunk at a
 * time (by elements and by stored bytes), and the text budget — each cut named in `coverage`, never silent.
 */
import { prisma } from '@/lib/db';
import { createBook } from '@/app-layer/usecases/books';
import { createElement } from '@/app-layer/usecases/bible-elements';
import { SEARCH_READ_LIMITS, searchBook, type SearchReadLimits } from '@/app-layer/usecases/book-search';
import { BibleElementRepository, BibleFieldRepository, BibleRelationRepository } from '@/app-layer/repositories/bible.repository';
import { addRelation } from '@/app-layer/usecases/bible-relations';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

const original = BibleFieldRepository.listForSearch;

afterAll(() => prisma.$disconnect());

const small = (over: Partial<SearchReadLimits> = {}): SearchReadLimits => ({ ...SEARCH_READ_LIMITS, elements: 3, fieldChunk: 2, ...over });

async function bookOf(n: number) {
    const ctx = workspaceCtx(await createAccount());
    const book = await createBook(ctx, { title: 'Bounds' });
    for (let i = 0; i < n; i++) {
        await createElement(ctx, book.id, { kind: 'CHARACTER', name: `Keeper ${String.fromCharCode(65 + i)}`, fields: [{ key: 'want', value: `To guard lamp number ${i}.` }] });
    }
    return { ctx, book };
}

it('reads every element and its fields across chunks when the book is within the bounds', async () => {
    const { ctx, book } = await bookOf(5);
    const r = await searchBook(ctx, book.id, { q: 'guarding lamps' }, { limits: small({ elements: 10 }) });
    expect(r.totalHits).toBe(5);
    expect(r.coverage).toEqual({ elements: 5, searchedElements: 5, complete: true, cut: null });
});

it('past the element cap: the first by name are searched, and the coverage says so', async () => {
    const { ctx, book } = await bookOf(5);
    const r = await searchBook(ctx, book.id, { q: 'keeper' }, { limits: small() });
    expect(r.hits.map((h) => h.name)).toEqual(['Keeper A', 'Keeper B', 'Keeper C']);
    expect(r.coverage).toEqual({ elements: 5, searchedElements: 3, complete: false, cut: 'ELEMENTS_CAP' });
});

it('past the text budget: reading stops, and the coverage says so', async () => {
    const { ctx, book } = await bookOf(5);
    // The title and the first element or two.
    const r = await searchBook(ctx, book.id, { q: 'keeper' }, { limits: small({ elements: 10, textChars: 60 }) });
    expect(r.coverage.cut).toBe('TEXT_BUDGET');
    expect(r.coverage.complete).toBe(false);
    expect(r.coverage.searchedElements).toBeGreaterThan(0);
    expect(r.coverage.searchedElements).toBeLessThan(5);
    expect(r.totalHits).toBe(r.coverage.searchedElements);
});

it('reads fields by stored bytes as well as by elements: no query holds more than the bytes bound (one element alone may)', async () => {
    const ctx = workspaceCtx(await createAccount());
    const book = await createBook(ctx, { title: 'Heavy' });
    const long = `<p>${'The keeper trimmed the wick and wrote the log. '.repeat(60)}</p>`;
    const heavy = new Set<string>();
    for (let i = 0; i < 5; i++) {
        heavy.add((await createElement(ctx, book.id, { kind: 'CHARACTER', name: `Keeper ${String.fromCharCode(65 + i)}`, fields: [{ key: 'wound', value: long }] })).id);
    }
    await createElement(ctx, book.id, { kind: 'CHARACTER', name: 'Keeper Z' });
    const reads: string[][] = [];
    const spy = jest.spyOn(BibleFieldRepository, 'listForSearch').mockImplementation((...args) => {
        reads.push([...args[2]]);
        return original(...args);
    });
    try {
        // One stored value is a few kilobytes: a bound of 5,000 bytes takes one element a query, not all six.
        const r = await searchBook(ctx, book.id, { q: 'wicks' }, { limits: { ...SEARCH_READ_LIMITS, fieldChunkBytes: 5_000 } });
        expect(r.totalHits).toBe(5);
        expect(r.coverage).toEqual({ elements: 6, searchedElements: 6, complete: true, cut: null });
        // Five queries of one heavy element each (the element with no field rides along, costing no bytes).
        expect(reads.map((ids) => ids.filter((id) => heavy.has(id)).length)).toEqual([1, 1, 1, 1, 1]);
    } finally {
        spy.mockRestore();
    }
});

it('reads summaries and relation notes by stored bytes too, and stops with the text budget: never all of them up front (Phase 3.H, #48 item 1)', async () => {
    const ctx = workspaceCtx(await createAccount());
    const book = await createBook(ctx, { title: 'Long summaries' });
    const long = 'The keeper trimmed the wick and wrote the log. '.repeat(80);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await createElement(ctx, book.id, { kind: 'CHARACTER', name: `Keeper ${String.fromCharCode(65 + i)}`, summary: long })).id);
    const note = 'The keeper trimmed the wick and wrote the log. '.repeat(40);
    for (let i = 1; i < 5; i++) await addRelation(ctx, book.id, { fromElementId: ids[i], toElementId: ids[i + 1], type: 'related_to', note });
    const summaryReads: string[][] = [];
    const noteReads: string[][] = [];
    const realSummaries = BibleElementRepository.summariesForSearch;
    const realNotes = BibleRelationRepository.notesByIds;
    const s2 = jest.spyOn(BibleElementRepository, 'summariesForSearch').mockImplementation((...args) => {
        summaryReads.push([...args[3]]);
        return realSummaries(...args);
    });
    const n2 = jest.spyOn(BibleRelationRepository, 'notesByIds').mockImplementation((...args) => {
        noteReads.push([...args[3]]);
        return realNotes(...args);
    });
    try {
        // Each summary and note is a few kilobytes: a 5,000-byte bound reads them an element at a time.
        const all = await searchBook(ctx, book.id, { q: 'wicks' }, { limits: { ...SEARCH_READ_LIMITS, fieldChunkBytes: 5_000 } });
        expect(all.coverage).toEqual({ elements: 6, searchedElements: 6, complete: true, cut: null });
        expect(all.totalHits).toBe(6);
        expect(summaryReads.every((r) => r.length === 1)).toBe(true);
        expect(summaryReads.flat().sort()).toEqual([...ids].sort());
        // Every note is read once, though both ends hold it.
        expect(noteReads.flat()).toHaveLength(4);
        expect(new Set(noteReads.flat()).size).toBe(4);

        // A small budget: reading stops, and what was never searched was never decrypted.
        summaryReads.length = 0;
        noteReads.length = 0;
        const cut = await searchBook(ctx, book.id, { q: 'wicks' }, { limits: { ...SEARCH_READ_LIMITS, fieldChunkBytes: 5_000, textChars: 6_000 } });
        expect(cut.coverage.cut).toBe('TEXT_BUDGET');
        expect(summaryReads.flat().length).toBeLessThan(6);
        expect(noteReads.flat().length).toBeLessThan(4);
    } finally {
        s2.mockRestore();
        n2.mockRestore();
    }
});
