/**
 * Word search's cost, held by COUNTED WORK and its growth rather than a wall
 * clock (Phase 3.4): over real, encrypted books of two sizes, twice the book
 * is twice the sources read and the words segmented — linear, never worse —
 * while stems, cached per request, grow only with the new words. The wall
 * clock at full size is the load test's (`bible-load.test.ts`).
 */
import { prisma } from '@/lib/db';
import { searchBook } from '@/app-layer/usecases/book-search';
import type { SearchWork } from '@/lib/search/rank';
import { seedLoadBook } from '../helpers/bible-load';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());
jest.setTimeout(120_000);

async function workOf(elements: number, q: string): Promise<{ work: SearchWork; hits: number; searched: number }> {
    const ctx = workspaceCtx(await createAccount());
    const book = await seedLoadBook(ctx, { elements, versions: 1 });
    let work: SearchWork | null = null;
    const r = await searchBook(ctx, book.bookId, { q }, { onWork: (w) => (work = w) });
    return { work: work!, hits: r.totalHits, searched: r.coverage.searchedElements };
}

it('grows linearly with the book, for a word in nearly every field', async () => {
    const small = await workOf(150, 'considered paragraphs');
    const large = await workOf(300, 'considered paragraphs');
    expect([small.searched, large.searched]).toEqual([150, 300]);
    expect(large.work.sourcesRead / small.work.sourcesRead).toBeCloseTo(2, 1);
    expect(large.work.wordsSegmented / small.work.wordsSegmented).toBeLessThanOrEqual(2.1);
    expect(large.work.wordsSegmented / small.work.wordsSegmented).toBeGreaterThanOrEqual(1.9);
    // The prose repeats; only the numbered names and lines bring new words.
    expect(large.work.stemsComputed).toBeLessThan(2 * small.work.stemsComputed);
    expect(large.hits).toBeGreaterThan(small.hits);
});

it('tokenises nothing it cannot match: a word the book never holds reads every source and segments none', async () => {
    const { work, hits } = await workOf(150, 'lighthouse');
    expect(hits).toBe(0);
    expect(work.sourcesRead).toBeGreaterThan(150);
    expect(work).toMatchObject({ sourcesTokenised: 0, wordsSegmented: 0, stemsComputed: 0 });
});
