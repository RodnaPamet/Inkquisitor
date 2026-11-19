/**
 * The bible pages under load (Phase 1.H, item 6): a book of many elements and
 * versions, and the server-side reads of its list and element pages held to
 * 300 ms at p95.
 *
 * The reads measured are exactly what each page makes (`bible-pages.ts`,
 * shared with the pages): the books list, the book page (board aggregates and
 * the first entries per kind), a page of the element list (the board's "show
 * more" and the relation picker's search), and the element page for the
 * element with the longest history.
 *
 * Size: CI runs a smaller book so the Test job keeps its time budget
 * (`BIBLE_LOAD_ELEMENTS` / `BIBLE_LOAD_VERSIONS`, default 400 / 4,000);
 * `npm run test:load` runs the roadmap's 2,000 elements and 20,000 versions.
 * The p95 bound is the same at every size. The numbers are printed (stderr)
 * and recorded in docs/implementation-notes/2026-11-19-1.H-phase-1-hardening.md.
 */
import { prisma } from '@/lib/db';
import { listElements } from '@/app-layer/usecases/bible-elements';
import { loadBookPage, loadBooksPage, loadElementPage } from '@/app-layer/usecases/bible-pages';
import { measure, seedLoadBook, type LoadBook } from '../helpers/bible-load';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

const ELEMENTS = Number(process.env.BIBLE_LOAD_ELEMENTS ?? 400);
const VERSIONS = Number(process.env.BIBLE_LOAD_VERSIONS ?? 4_000);
const RUNS = Number(process.env.BIBLE_LOAD_RUNS ?? 30);
const P95_BOUND_MS = 300;

let ctx: ReturnType<typeof workspaceCtx>;
let book: LoadBook;
const results: Record<string, { p50: number; p95: number; max: number }> = {};

jest.setTimeout(30 * 60 * 1000);

beforeAll(async () => {
    ctx = workspaceCtx(await createAccount());
    const started = performance.now();
    book = await seedLoadBook(ctx, { elements: ELEMENTS, versions: VERSIONS });
    process.stderr.write(`bible load: seeded ${ELEMENTS} elements and ${VERSIONS} versions in ${Math.round(performance.now() - started)} ms\n`);
});

afterAll(() => {
    const lines = Object.entries(results).map(([page, r]) => `  ${page.padEnd(16)} p50 ${r.p50.toFixed(1)} ms   p95 ${r.p95.toFixed(1)} ms   max ${r.max.toFixed(1)} ms`);
    process.stderr.write(`bible load (${ELEMENTS} elements, ${VERSIONS} versions, ${RUNS} runs):\n${lines.join('\n')}\n`);
});

it('seeded what it says (a load test over an empty book proves nothing)', async () => {
    expect(await prisma.bibleElement.count({ where: { bookId: book.bookId } })).toBe(ELEMENTS);
    expect(await prisma.bibleEntryVersion.count({ where: { bookId: book.bookId } })).toBe(VERSIONS);
    expect(await prisma.bibleEntryVersion.count({ where: { elementId: book.hotElementId } })).toBeGreaterThanOrEqual(Math.floor(VERSIONS / 10));
    const { board } = await loadBookPage(ctx, book.bookId);
    expect(board.reduce((n, k) => n + k.entryCount, 0)).toBe(ELEMENTS);
});

it.each([
    ['books list', () => loadBooksPage(ctx)],
    ['book page', () => loadBookPage(ctx, book.bookId)],
    ['element list', () => listElements(ctx, book.bookId, { take: 100 })],
    ['picker search', () => listElements(ctx, book.bookId, { kinds: ['CHARACTER', 'FACTION'], q: 'entry 01', take: 21 })],
    ['element page', () => loadElementPage(ctx, book.bookId, book.hotElementId)],
] as const)(`%s: p95 under ${P95_BOUND_MS} ms`, async (page, read) => {
    const r = await measure(read, RUNS);
    results[page] = r;
    expect(r.p95).toBeLessThan(P95_BOUND_MS);
});
