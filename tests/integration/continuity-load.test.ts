/**
 * The Continuity page under load (Phase 4.H-b, roadmap 4.H item 6): a book of
 * many facts — every list on the page full and past its bound — and the
 * page's server-side read held to 300 ms at p95, as the bible pages are
 * (`bible-load.test.ts`, the same `measure`, the same bound).
 *
 * The read measured is exactly what the page makes (`getContinuityPage`):
 * the live-fact count, the pending proposals of each reason (counted, and the
 * first `CONTINUITY_LIST_MAX` of each with both facts and their origins), the
 * threads and thread proposals, the "decide later" answers, the stale flags,
 * the nightly check's state and the backfill's progress. The Facts page's
 * proposals read (`listFactProposals`) is measured beside it.
 *
 * Bounded, and COUNTED: the page's statements are counted (every statement the
 * driver sends, transaction control included) for a book of 1,000 facts and
 * for the load book, and must be the same number — no read grows with the
 * facts a book holds.
 *
 * Size: CI runs a smaller book so the Test job keeps its time budget
 * (`CONTINUITY_LOAD_FACTS`, default 2,000); `npm run test:load` runs the
 * roadmap's 10,000 facts. The p95 bound is the same at every size. The numbers
 * are printed (stderr) and recorded in
 * docs/implementation-notes/2026-11-27-4.H-b-hardening.md.
 */
import pg from 'pg';
import { prisma } from '@/lib/db';
import { getContinuityPage } from '@/app-layer/usecases/continuity';
import { listFactProposals } from '@/app-layer/usecases/fact-proposals';
import { CONTINUITY_LIST_MAX } from '@/lib/continuity/vocabulary';
import { measure, seedLoadBook, seedLoadFacts, type LoadBook, type LoadFacts } from '../helpers/bible-load';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

const FACTS = Number(process.env.CONTINUITY_LOAD_FACTS ?? 2_000);
const SMALL_FACTS = 1_000;
const RUNS = Number(process.env.BIBLE_LOAD_RUNS ?? 30);
const P95_BOUND_MS = 300;

let ctx: ReturnType<typeof workspaceCtx>;
let book: LoadBook;
let small: LoadBook;
let seeded: LoadFacts;
const results: Record<string, { p50: number; p95: number; max: number }> = {};

jest.setTimeout(30 * 60 * 1000);

beforeAll(async () => {
    ctx = workspaceCtx(await createAccount());
    // Statistics taken BEFORE the book exists (as right after a large import): a plan fast only on fresh statistics is measured at its worst.
    await prisma.$executeRawUnsafe('ANALYZE "StoryFact", "StoryFactProposal", "StoryThread", "StoryThreadProposal", "StaleFlag", "BibleFactExtraction"');
    const started = performance.now();
    book = await seedLoadBook(ctx, { elements: 400, versions: 400 });
    seeded = await seedLoadFacts(ctx, book, FACTS);
    small = await seedLoadBook(ctx, { elements: 400, versions: 400 });
    await seedLoadFacts(ctx, small, SMALL_FACTS);
    process.stderr.write(`continuity load: seeded ${FACTS} and ${SMALL_FACTS} facts in ${Math.round(performance.now() - started)} ms\n`);
});

afterAll(() => {
    const lines = Object.entries(results).map(([page, r]) => `  ${page.padEnd(16)} p50 ${r.p50.toFixed(1)} ms   p95 ${r.p95.toFixed(1)} ms   max ${r.max.toFixed(1)} ms`);
    process.stderr.write(`continuity load (${FACTS} facts, ${RUNS} runs):\n${lines.join('\n')}\n`);
});

it('seeded what it says (a load test over an empty book proves nothing): every list past its bound', async () => {
    const page = await getContinuityPage(ctx, book.bookId);
    expect(page.liveFacts).toBe(FACTS);
    expect(page.contradictions.pending).toBe(seeded.contradictions);
    expect(page.contradictions.items).toHaveLength(CONTINUITY_LIST_MAX);
    expect(page.contradictions.truncated).toBe(true);
    expect(page.threads.truncated).toBe(true);
    expect(page.threadProposals.truncated).toBe(false);
});

it.each([
    ['continuity page', () => getContinuityPage(ctx, book.bookId)],
    ['facts proposals', () => listFactProposals(ctx, book.bookId)],
] as const)(`%s: p95 under ${P95_BOUND_MS} ms`, async (page, read) => {
    const r = await measure(read, RUNS);
    results[page] = r;
    expect(r.p95).toBeLessThan(P95_BOUND_MS);
});

it(`the page's statements do not grow with the facts: the same count for ${SMALL_FACTS} facts as for ${FACTS}`, async () => {
    const count = async (bookId: string): Promise<number> => {
        await getContinuityPage(ctx, bookId);
        const spy = jest.spyOn(pg.Client.prototype, 'query');
        try {
            await getContinuityPage(ctx, bookId);
            return spy.mock.calls.length;
        } finally {
            spy.mockRestore();
        }
    };
    const few = await count(small.bookId);
    const many = await count(book.bookId);
    process.stderr.write(`continuity load: the page made ${few} statements at ${SMALL_FACTS} facts, ${many} at ${FACTS}\n`);
    expect(few).toBeGreaterThan(0);
    expect(many).toBe(few);
});
