/**
 * HARDENING THE NIGHTLY CONTINUITY CHECK (Phase 4.H-a, D31), against a real
 * PostgreSQL. The deep check is a scripted checker; nothing reaches a network.
 *
 *   #62 item 1   a pass over a cut set of facts is never reported complete: the
 *                Continuity page names the cut
 *   #62 item 3   a page that fails night after night (an answer never valid, a call
 *                always over budget) is passed over after a bounded number of
 *                nights, counted and shown, and the pass goes on
 *   #62 item 4   a second dispatch in one night queues nothing for a book already
 *                queued that night
 *   D32 (4.H-b)  a subject passed over is remembered, retried in the next pass (a
 *                book with nothing new is queued again a week after its last run),
 *                and no pass is complete while one is outstanding
 */
import { prisma } from '@/lib/db';
import { runWithoutRls } from '@/lib/db/rls-middleware';
import { createBook } from '@/app-layer/usecases/books';
import { createElement } from '@/app-layer/usecases/bible-elements';
import { getContinuityPage } from '@/app-layer/usecases/continuity';
import { getGapHuntPage } from '@/app-layer/usecases/gap-hunts';
import { getStressTestPage } from '@/app-layer/usecases/stress-tests';
import { executeContinuityDispatch } from '@/app-layer/usecases/continuity-dispatch';
import { executeContinuityCheck } from '@/app-layer/usecases/continuity-check';
import { CONTINUITY_FACTS_READ_MAX, CONTINUITY_PAGE_FAILURES_MAX, CONTINUITY_PASS_SETTLE_MS } from '@/lib/continuity/vocabulary';
import type { ContinuityChecker } from '@/lib/continuity/model-seam';
import { setFakeApiKey } from '../helpers/fake-anthropic';
import { ageExtractor, cloneFact, extractPending } from '../helpers/facts';
import { nextTestNight, runNight } from '../helpers/continuity';
import { CONTINUITY_PASSED_OVER_RETRY_MS } from '@/lib/continuity/vocabulary';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

type Ctx = ReturnType<typeof workspaceCtx>;

const quiet = (): ContinuityChecker => ({ extract: async () => ({ ok: true, output: { contradictions: [] }, tokensUsed: 1, costMicroUsd: 1, callIds: [] }) });
const neverValid = (): ContinuityChecker => ({ extract: async () => ({ ok: false, failure: 'INVALID_OUTPUT', errorCode: 'INVALID_OUTPUT', tokensUsed: 10, costMicroUsd: 10, callIds: [] }) });

async function ageFacts(ctx: Ctx, bookId: string, names: readonly string[]): Promise<void> {
    for (const name of names) {
        await createElement(ctx, bookId, { kind: 'CHARACTER', name, summary: `${name} is 30 years old.` });
        await extractPending(ctx, bookId, ageExtractor(name));
    }
}

async function checkState(bookId: string) {
    return runWithoutRls({ reason: 'test' }, (db) => db.continuityCheck.findFirstOrThrow({ where: { bookId }, select: { passTarget: true, passCursor: true, pageFailures: true, parkedSubjects: true, coveredThrough: true } }));
}

describe('a second dispatch in one night (#62 item 4)', () => {
    it('queues nothing for a book already queued that night, mid-pass or not; the next night queues it again', async () => {
        const ctx = workspaceCtx(await createAccount());
        const bookId = (await createBook(ctx, { title: 'Twice a night' })).id;
        await ageFacts(ctx, bookId, ['Ada']);
        // No evaluation record: the pass stays under way, so the book stays due night after night.
        const refused = { gate: () => ({ mounted: false as const, reason: 'STRUCTURAL_RECORD_REFUSED' as const, detail: '' }) };
        const night = async (nightKey: string) => {
            const queued: string[] = [];
            const r = await executeContinuityDispatch({ nightKey, workspaceIds: [ctx.workspaceId], enqueue: async (_n, payload) => void queued.push((payload as { runId: string }).runId) });
            // Discovery itself leaves the book out (the unique index is the second line, for two dispatches at once).
            expect(r.due).toBe(queued.length);
            const undo = setFakeApiKey();
            try {
                for (const runId of queued) await executeContinuityCheck({ workspaceId: ctx.workspaceId, runId }, { charge: () => undefined, now: () => new Date(Date.now() + CONTINUITY_PASS_SETTLE_MS), ...refused });
            } finally {
                undo();
            }
            return queued.length;
        };
        expect(await night('2026-11-25')).toBe(1);
        expect((await checkState(bookId)).passTarget).not.toBeNull();
        // The same night, dispatched again: nothing (before 4.H-a the mid-pass book was queued a second time).
        expect(await night('2026-11-25')).toBe(0);
        expect(await night('2026-11-26')).toBe(1);

        // Two dispatches of one night at once: one run between them, the unique index answering the other.
        const results = await Promise.all([0, 1].map(() => executeContinuityDispatch({ nightKey: '2026-11-27', workspaceIds: [ctx.workspaceId], enqueue: async () => undefined })));
        expect(results.reduce((n, r) => n + r.queued, 0)).toBe(1);
        const tonight = await runWithoutRls({ reason: 'test' }, (db) => db.continuityRun.count({ where: { bookId, nightKey: '2026-11-27' } }));
        expect(tonight).toBe(1);
    });
});

describe('a page that can never succeed (#62 item 3)', () => {
    it('an answer never valid: the page is passed over after CONTINUITY_PAGE_FAILURES_MAX nights, counted and shown, and the pass goes on', async () => {
        const ctx = workspaceCtx(await createAccount());
        const bookId = (await createBook(ctx, { title: 'Stuck' })).id;
        await ageFacts(ctx, bookId, ['Ada', 'Bo']);
        const onePage = { callsPerNight: 1, factsPerCall: 1 };
        for (let n = 1; n < CONTINUITY_PAGE_FAILURES_MAX; n++) {
            expect(await runNight(ctx, { checker: neverValid, ...onePage })).toEqual(['CALL_FAILED']);
            expect(await checkState(bookId)).toMatchObject({ passCursor: null, pageFailures: n, parkedSubjects: 0 });
        }
        // The last allowed failure: the page is passed over (its one subject), the cursor past it.
        expect(await runNight(ctx, { checker: neverValid, ...onePage })).toEqual(['CALL_FAILED']);
        const parked = await checkState(bookId);
        expect(parked).toMatchObject({ pageFailures: 0, parkedSubjects: 1 });
        expect(parked.passCursor).not.toBeNull();

        // The next night goes on past it (before 4.H-a it retried the same page for ever) and finishes the pass.
        let checked = 0;
        const counting = (): ContinuityChecker => ({ extract: async (r) => (checked++, quiet().extract(r)) });
        expect(await runNight(ctx, { checker: counting, ...onePage })).toEqual(['OK']);
        expect(checked).toBe(1);
        const page = await getContinuityPage(ctx, bookId);
        expect(page.nightly).toMatchObject({ outcome: 'OK', parkedSubjects: 1, complete: false });
    });

    it('a call always over the per-call budget is passed over the same way', async () => {
        const ctx = workspaceCtx(await createAccount());
        const bookId = (await createBook(ctx, { title: 'Too large' })).id;
        await ageFacts(ctx, bookId, ['Cyr']);
        const overBudget = { checker: quiet, worstCase: () => Number.MAX_SAFE_INTEGER };
        for (let n = 1; n <= CONTINUITY_PAGE_FAILURES_MAX; n++) expect(await runNight(ctx, overBudget)).toEqual(['CALL_OVER_BUDGET']);
        expect(await checkState(bookId)).toMatchObject({ parkedSubjects: 1, pageFailures: 0 });
        // Nothing is left of the pass: it completes, and the page says one subject was passed over.
        expect(await runNight(ctx, overBudget)).toEqual(['OK']);
        expect((await getContinuityPage(ctx, bookId)).nightly).toMatchObject({ parkedSubjects: 1, complete: false });
    });

    it('a page the guard refused is passed over at once, counted with the passed-over subjects: the finished pass is not complete', async () => {
        const ctx = workspaceCtx(await createAccount());
        const bookId = (await createBook(ctx, { title: 'Refused' })).id;
        await ageFacts(ctx, bookId, ['Ada', 'Bo']);
        const onePage = { callsPerNight: 1, factsPerCall: 1 };
        let calls = 0;
        const refusesFirst = (): ContinuityChecker => ({
            extract: async (r) => (calls++ === 0 ? { ok: false, failure: 'GUARD_REFUSED', errorCode: 'GUARD', tokensUsed: 10, costMicroUsd: 10, callIds: [] } : quiet().extract(r)),
        });
        expect(await runNight(ctx, { checker: refusesFirst, ...onePage })).toEqual(['GUARD_REFUSED']);
        expect(await checkState(bookId)).toMatchObject({ parkedSubjects: 1 });
        expect(await runNight(ctx, { checker: refusesFirst, ...onePage })).toEqual(['OK']);
        // Before this was counted, the pass ended "every fact checked" with one subject never checked.
        const page = await getContinuityPage(ctx, bookId);
        expect(page.nightly).toMatchObject({ outcome: 'OK', parkedSubjects: 1, complete: false });
    });

    it('a timeout is not the page’s fault: it is never counted against the page', async () => {
        const ctx = workspaceCtx(await createAccount());
        const bookId = (await createBook(ctx, { title: 'Flaky' })).id;
        await ageFacts(ctx, bookId, ['Dov']);
        const timeout = (): ContinuityChecker => ({ extract: async () => ({ ok: false, failure: 'TIMEOUT', errorCode: 'TIMEOUT', tokensUsed: 0, costMicroUsd: 0, callIds: [] }) });
        for (let n = 1; n <= CONTINUITY_PAGE_FAILURES_MAX + 1; n++) expect(await runNight(ctx, { checker: timeout })).toEqual(['CALL_FAILED']);
        expect(await checkState(bookId)).toMatchObject({ pageFailures: 0, parkedSubjects: 0, passCursor: null });
    });
});

describe('passed-over subjects are remembered (D32, 4.H-b)', () => {
    it('a subject the guard refused is stored, outstanding on the page, retried in the next pass, and the check completes only once it is checked', async () => {
        const ctx = workspaceCtx(await createAccount());
        const bookId = (await createBook(ctx, { title: 'Remembered' })).id;
        await ageFacts(ctx, bookId, ['Ada', 'Bo']);
        const onePage = { callsPerNight: 1, factsPerCall: 1 };
        let refusing = true;
        const seen: string[] = [];
        const checker = (): ContinuityChecker => ({
            extract: async (r) => {
                const text = r.data.map((b) => b.text).join('\n');
                seen.push(text);
                if (refusing && text.includes('Ada')) return { ok: false, failure: 'GUARD_REFUSED', errorCode: 'GUARD', tokensUsed: 10, costMicroUsd: 10, callIds: [] };
                return quiet().extract(r);
            },
        });
        expect(await runNight(ctx, { checker, ...onePage })).toEqual(['GUARD_REFUSED']);
        expect(await runNight(ctx, { checker, ...onePage })).toEqual(['OK']);
        const stored = await runWithoutRls({ reason: 'test' }, (db) => db.continuityCheck.findFirstOrThrow({ where: { bookId }, select: { passedOver: true, passedOverCut: true } }));
        expect(stored.passedOver).toHaveLength(1);
        expect(stored.passedOverCut).toBe(false);
        let page = await getContinuityPage(ctx, bookId);
        expect(page.nightly).toMatchObject({ outcome: 'OK', passedOverOutstanding: 1, complete: false });

        // Nothing new the next night, so the book is not queued: it is not retried every night.
        const queuedTomorrow: string[] = [];
        await executeContinuityDispatch({ enqueue: async (_n, p) => void queuedTomorrow.push((p as { runId: string }).runId), workspaceIds: [ctx.workspaceId], nightKey: nextTestNight(), now: () => new Date(Date.now() + 86_400_000) });
        expect(queuedTomorrow).toEqual([]);

        // A week on, the book is queued for a pass that retries the remembered subject (and only it: Bo has not changed).
        refusing = false;
        seen.length = 0;
        const later = new Date(Date.now() + CONTINUITY_PASSED_OVER_RETRY_MS + 86_400_000);
        const queued: string[] = [];
        await executeContinuityDispatch({ enqueue: async (_n, p) => void queued.push((p as { runId: string }).runId), workspaceIds: [ctx.workspaceId], nightKey: nextTestNight(), now: () => later });
        expect(queued).toHaveLength(1);
        const undo = setFakeApiKey();
        try {
            const r = await executeContinuityCheck({ workspaceId: ctx.workspaceId, runId: queued[0] }, { checker, ...onePage, charge: () => undefined, gate: () => ({ mounted: true, recordKind: 'structural' }), now: () => later });
            expect(r.outcome).toBe('OK');
        } finally {
            undo();
        }
        expect(seen).toHaveLength(1);
        expect(seen[0]).toContain('Ada');
        page = await getContinuityPage(ctx, bookId);
        expect(page.nightly).toMatchObject({ outcome: 'OK', passedOverOutstanding: 0, parkedSubjects: 0, complete: true });
    });
});

describe('a pass over a cut set of facts (#62 item 1)', () => {
    it('is never reported complete: the page names the cut, and a pass with nothing cut is', async () => {
        const ctx = workspaceCtx(await createAccount());
        const bookId = (await createBook(ctx, { title: 'Enormous' })).id;
        await ageFacts(ctx, bookId, ['Eli']);
        expect(await runNight(ctx, { checker: quiet })).toEqual(['OK']);
        expect((await getContinuityPage(ctx, bookId)).nightly).toMatchObject({ outcome: 'OK', factsCut: false, complete: true });

        // More live facts than one night reads.
        const fact = await runWithoutRls({ reason: 'test' }, (db) => db.storyFact.findFirstOrThrow({ where: { bookId }, select: { id: true } }));
        await cloneFact(fact.id, CONTINUITY_FACTS_READ_MAX, { predicate: 'OTHER' });
        expect(await runNight(ctx, { checker: quiet })).toEqual(['OK']);
        const page = await getContinuityPage(ctx, bookId);
        expect(page.nightly).toMatchObject({ outcome: 'OK', factsCut: true, complete: false, factsRead: CONTINUITY_FACTS_READ_MAX });
    }, 60_000);
});

describe('zero is never complete (roadmap 4.H item 7; rule 6)', () => {
    it('an empty fact set reads "not assessed" on the Continuity page, the nightly check says NO_FACTS, and nothing is complete', async () => {
        const ctx = workspaceCtx(await createAccount());
        const bookId = (await createBook(ctx, { title: 'Silent' })).id;
        // An entry that states nothing: its extraction writes no fact.
        await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Nobody' });
        await extractPending(ctx, bookId, ageExtractor('Nobody'));
        const before = await getContinuityPage(ctx, bookId);
        expect(before).toMatchObject({ assessed: false, liveFacts: 0 });
        expect(before.nightly.complete).toBe(false);
        const undo = setFakeApiKey();
        try {
            const gap = await getGapHuntPage(ctx, (await createBook(ctx, { title: 'Empty' })).id, { gate: () => ({ mounted: true, recordKind: 'structural' }) });
            expect(gap.assessed).toBe(false);
            const stress = await getStressTestPage(ctx, (await createBook(ctx, { title: 'Emptier' })).id, { gate: () => ({ mounted: true, recordKind: 'structural' }) });
            expect(stress).toMatchObject({ assessed: false, estimate: null });
        } finally {
            undo();
        }
        // A night over a book with no fact checks nothing (it is not even due) and is never reported clean.
        expect(await runNight(ctx, { checker: quiet })).toEqual([]);
        const after = await getContinuityPage(ctx, bookId);
        expect(after.assessed).toBe(false);
        expect(after.nightly.complete).toBe(false);
    });
});
