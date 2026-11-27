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
 * Word search (Phase 3.4, decision D21) is measured beside them under its own
 * bound, `WORD_SEARCH_P95_BOUND_MS`: option A reads and decrypts the WHOLE
 * book on every search (every summary, field value and relation note), so
 * its cost grows with the book where a page's does not. At the roadmap's
 * 2,000 elements the decryption and row reads alone are a few hundred
 * milliseconds here; the 3.4 note records the numbers, and its counted-work
 * test (`book-search-work.test.ts`) holds how the work grows.
 *
 * Size: CI runs a smaller book so the Test job keeps its time budget
 * (`BIBLE_LOAD_ELEMENTS` / `BIBLE_LOAD_VERSIONS` / `BIBLE_LOAD_MANUSCRIPT_WORDS`, default 400 / 4,000 / 30,000);
 * `npm run test:load` runs the roadmap's 2,000 elements and 20,000 versions, and since Phase 5.H-a a
 * 150,000-word manuscript (roadmap 5.H item 1's size), which word search reads beside the bible under the same bound.
 * The p95 bound is the same at every size. The numbers are printed (stderr)
 * and recorded in docs/implementation-notes/2026-11-19-1.H-phase-1-hardening.md.
 */
import { prisma } from '@/lib/db';
import { listElements } from '@/app-layer/usecases/bible-elements';
import { loadBookPage, loadBooksPage, loadElementPage } from '@/app-layer/usecases/bible-pages';
import { searchBook } from '@/app-layer/usecases/book-search';
import { measure, seedLoadBook, seedLoadManuscript, type LoadBook } from '../helpers/bible-load';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

const ELEMENTS = Number(process.env.BIBLE_LOAD_ELEMENTS ?? 400);
const VERSIONS = Number(process.env.BIBLE_LOAD_VERSIONS ?? 4_000);
const RUNS = Number(process.env.BIBLE_LOAD_RUNS ?? 30);
/** Phase 5.H-a: the manuscript word search reads beside the bible (CI 30,000 words; `npm run test:load` 150,000). */
const MANUSCRIPT_WORDS = Number(process.env.BIBLE_LOAD_MANUSCRIPT_WORDS ?? 30_000);
const P95_BOUND_MS = 300;
/** Word search's bound: a whole-book read and decrypt per request (option A, the 3.4 note). */
const WORD_SEARCH_P95_BOUND_MS = 1_000;

let ctx: ReturnType<typeof workspaceCtx>;
let book: LoadBook;
const results: Record<string, { p50: number; p95: number; max: number }> = {};

jest.setTimeout(30 * 60 * 1000);

beforeAll(async () => {
    ctx = workspaceCtx(await createAccount());
    // The planner's statistics are taken BEFORE the book exists, as they are
    // in production right after a large import (autoanalyze waits for a tenth
    // of a table to change). A query whose plan is only fast when the
    // statistics already know the book (a nested loop chosen on an estimate
    // of one row, scanning every field of the workspace per element) is
    // measured here at its worst, not by luck of when autoanalyze last ran.
    await prisma.$executeRawUnsafe('ANALYZE "Book", "BibleElement", "BibleField", "BibleRelation", "BibleEntryVersion"');
    const started = performance.now();
    book = await seedLoadBook(ctx, { elements: ELEMENTS, versions: VERSIONS });
    const manuscript = await seedLoadManuscript(ctx, book.bookId, MANUSCRIPT_WORDS);
    process.stderr.write(`bible load: seeded ${ELEMENTS} elements, ${VERSIONS} versions and a ${manuscript.words}-word manuscript in ${Math.round(performance.now() - started)} ms\n`);
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
    // Phase 5.H-a: the manuscript is there, and word search reads all of it (no cut).
    const words = await prisma.manuscriptScene.aggregate({ where: { bookId: book.bookId }, _sum: { wordCount: true } });
    expect(words._sum.wordCount).toBeGreaterThanOrEqual(MANUSCRIPT_WORDS * 0.9);
    const r = await searchBook(ctx, book.bookId, { q: 'harbour' });
    expect(r.coverage).toMatchObject({ complete: true, cut: null });
    expect(r.coverage.searchedScenes).toBe(r.coverage.scenes);
    expect(r.hits.some((h) => h.kind === 'scene')).toBe(true);
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

// Word search (Phase 3.4): the whole book read, decrypted, turned into plain text and ranked on every
// request. A word in almost every field (the worst case: every rich-text source tokenised), and a name.
it.each([
    ['search (common)', () => searchBook(ctx, book.bookId, { q: 'considered paragraphs' })],
    ['search (a name)', () => searchBook(ctx, book.bookId, { q: 'entry 00042' })],
    // Phase 5.H-a: a word all through the manuscript (every scene tokenised) — the scenes read with the bible.
    ['search (scenes)', () => searchBook(ctx, book.bookId, { q: 'rowed harbour' })],
] as const)(`%s: p95 under ${WORD_SEARCH_P95_BOUND_MS} ms`, async (page, read) => {
    const r = await measure(read, RUNS);
    results[page] = r;
    expect(r.p95).toBeLessThan(WORD_SEARCH_P95_BOUND_MS);
});
