/**
 * Word search's read bounds (Phase 3.4), with the limits shrunk
 * (`searchBook`'s `limits`) so a small book crosses them: the elements read by name, the fields read a chunk at a
 * time, and the text budget — each cut named in `coverage`, never silent.
 */
import { prisma } from '@/lib/db';
import { createBook } from '@/app-layer/usecases/books';
import { createElement } from '@/app-layer/usecases/bible-elements';
import { SEARCH_READ_LIMITS, searchBook, type SearchReadLimits } from '@/app-layer/usecases/book-search';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

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
