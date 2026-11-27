/**
 * HARDENING PHASE 4: SCALE (Phase 4.H-b; D31, D32), against a real PostgreSQL.
 * Every model step is a scripted extractor; nothing reaches a network.
 *
 *   D32 / #60.2   a section the guard refused is re-sent ONCE when the guard's rule
 *                 version is newer than the one that refused it (then the baseline
 *                 moves past it again if the new rules refuse it too)
 *   item 5, D32   the backfill of bibles saved before 4.1: the newest version of each
 *                 entry never extracted, resumable, bounded a tick, under the daily
 *                 share and the ceiling, idempotent, never in the minutely dispatch
 *   #60.4         the minutely discovery serves every busy workspace within
 *                 ⌈busy ÷ per-tick bound⌉ ticks, more than 200 of them included
 *   #62.2         an autosave of a heavily cited element rewrites no standing flag
 *   4.H-a review  the book purge's discovery shares a run between workspaces
 */
import { prisma, workspaceKeys } from '@/lib/db';
import { runInWorkspaceContext, runWithoutRls } from '@/lib/db/rls-middleware';
import { createBook, deleteBook } from '@/app-layer/usecases/books';
import { createElement, updateElement } from '@/app-layer/usecases/bible-elements';
import { executeBibleFactExtraction } from '@/app-layer/usecases/bible-facts';
import { executeFactBackfill } from '@/app-layer/usecases/fact-backfill';
import { executeFactLayerDispatch } from '@/app-layer/usecases/fact-layer-dispatch';
import { getContinuityPage } from '@/app-layer/usecases/continuity';
import { purgeDeletedBooks } from '@/app-layer/usecases/book-purge';
import { BookRepository } from '@/app-layer/repositories/book.repository';
import { createWorkspaceWithDek } from '@/app-layer/repositories/workspace.repository';
import { restoreCutoff } from '@/lib/bible/book-retention';
import type { FactExtractor } from '@/lib/sources/extractor';
import type { NightlyShare } from '@/app-layer/usecases/model-calls';
import { setFakeApiKey } from '../helpers/fake-anthropic';
import { ageExtractor, extractPending } from '../helpers/facts';
import { answerAbout, citeAnswers } from '../helpers/continuity';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

// The guard's rule version, moved by the D32 test (a getter: every importer reads it live).
let mockGuardRulesVersion = 1;
jest.mock('@/lib/ai/guard/version', () => ({
    get GUARD_RULES_VERSION() {
        return mockGuardRulesVersion;
    },
}));

jest.setTimeout(10 * 60 * 1000);

const MOUNTED = () => ({ mounted: true as const, recordKind: 'structural' as const });

let undoKey: () => void;
beforeAll(() => {
    undoKey = setFakeApiKey();
});
afterAll(async () => {
    undoKey();
    await prisma.$disconnect();
});

const unique = () => Math.random().toString(36).slice(2, 10);

describe('a refused section is retried once on a safety update (D32)', () => {
    afterEach(() => {
        mockGuardRulesVersion = 1;
    });

    it('records the rule version that refused it, carries it while unchanged, and re-sends it once when the guard is newer', async () => {
        const ctx = workspaceCtx(await createAccount());
        const bookId = (await createBook(ctx, { title: 'Safety' })).id;
        const sent: string[] = [];
        let refuseUnder = (version: number) => version >= 1;
        const extractor = (): FactExtractor => ({
            async extract(request) {
                const text = request.data.find((b) => b.label === 'entry.text')?.text ?? '';
                sent.push(text);
                if (text.includes('XQZ') && refuseUnder(mockGuardRulesVersion)) return { ok: false, failure: 'GUARD_REFUSED', errorCode: 'GUARD', tokensUsed: 0, costMicroUsd: 0, callIds: [] };
                const facts = text.includes('XQZ') ? [{ subject: 'Wren', predicate: 'WANT', object: '', statement: 'Wren wants to speak the XQZ phrase to the river.', quote: 'To speak the XQZ phrase to the river.', storyTimeFrom: '', storyTimeTo: '', contradicts: [] }] : [];
                const age = await ageExtractor('Wren')().extract(request);
                return age.ok ? { ...age, output: { facts: [...((age.output as { facts: unknown[] }).facts ?? []), ...facts] } } : age;
            },
        });
        const extractions = async () => runWithoutRls({ reason: 'test' }, (db) => db.bibleFactExtraction.findMany({ where: { bookId }, orderBy: { createdAt: 'asc' }, select: { status: true, outcome: true, guardRefused: true } }));
        const el = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Wren', summary: 'Wren keeps the lock at Harrow Weir.', fields: [{ key: 'want', value: 'To speak the XQZ phrase to the river.' }] });
        expect(await extractPending(ctx, bookId, extractor)).toEqual(['GUARD_REFUSED']);
        // The refused call carried the entry's two short sections together: both are recorded refused, under version 1.
        expect((await extractions())[0]).toMatchObject({ status: 'DONE', guardRefused: [{ key: 'summary', rulesVersion: 1 }, { key: 'want', rulesVersion: 1 }] });

        // Same rules: the refused section is not sent with the next version, and its refusal is carried forward.
        await updateElement(ctx, bookId, el.id, { summary: 'Wren is 12 years old. Wren keeps the lock at Harrow Weir.', baseVersion: 1 });
        expect(await extractPending(ctx, bookId, extractor)).toEqual(['OK']);
        expect(sent[1]).not.toContain('XQZ');
        expect((await extractions())[1].guardRefused).toEqual([{ key: 'want', rulesVersion: 1 }]);

        // The guard's rules change, and still refuse it: sent ONCE, in a call of its own (the changed summary's facts are
        // still drawn), the refusal recorded under the new version.
        mockGuardRulesVersion = 2;
        await updateElement(ctx, bookId, el.id, { summary: 'Wren is 13 years old. Wren keeps the lock at Harrow Weir.', baseVersion: 2 });
        await extractPending(ctx, bookId, extractor);
        expect(sent.slice(2).filter((t) => t.includes('XQZ'))).toHaveLength(1);
        expect((await extractions())[2].guardRefused).toEqual([{ key: 'want', rulesVersion: 2 }]);
        expect(sent.slice(2).find((t) => t.includes('XQZ'))).not.toContain('13 years old');
        await updateElement(ctx, bookId, el.id, { summary: 'Wren is 14 years old. Wren keeps the lock at Harrow Weir.', baseVersion: 3 });
        const before = sent.length;
        await extractPending(ctx, bookId, extractor);
        expect(sent.slice(before).some((t) => t.includes('XQZ'))).toBe(false);

        // A newer guard that lets it pass: sent once more, its fact drawn, and nothing left recorded.
        mockGuardRulesVersion = 3;
        refuseUnder = (version) => version < 3;
        await updateElement(ctx, bookId, el.id, { summary: 'Wren is 15 years old. Wren keeps the lock at Harrow Weir.', baseVersion: 4 });
        await extractPending(ctx, bookId, extractor);
        const last = (await extractions()).at(-1)!;
        expect(last).toMatchObject({ status: 'DONE', guardRefused: null });
        const wants = await runWithoutRls({ reason: 'test' }, (db) => db.storyFact.count({ where: { bookId, predicate: 'WANT', supersededAt: null } }));
        expect(wants).toBe(1);
    });
});

/** Make a book's entries look saved before 4.1: their extraction rows gone (the outbox trigger did not exist then). */
async function forgetExtractions(bookId: string): Promise<void> {
    await runWithoutRls({ reason: 'test' }, (db) => db.bibleFactExtraction.deleteMany({ where: { bookId } }));
}

function recordingEnqueue() {
    const queued: Array<{ workspaceId: string; extractionId: string }> = [];
    return { queued, enqueue: async (_n: string, p: unknown) => void queued.push(p as { workspaceId: string; extractionId: string }) };
}

const BACKFILL_DEPS = { extractionOpen: () => true, callFloorMicroUsd: () => 1, dailyCapMicroUsd: 1_000_000_000 };

describe('the backfill of bibles saved before 4.1 (roadmap 4.H item 5; D31, D32)', () => {
    it('gives the NEWEST version of each entry never extracted a BACKFILL row, queues it, reads it, shows progress, and is idempotent', async () => {
        const ctx = workspaceCtx(await createAccount());
        const bookId = (await createBook(ctx, { title: 'Old bible' })).id;
        const wren = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Wren', summary: 'Wren is 12 years old. Wren keeps the lock at Harrow Weir.' });
        await updateElement(ctx, bookId, wren.id, { summary: 'Wren is 13 years old. Wren keeps the lock at Harrow Weir.', baseVersion: 1 });
        await updateElement(ctx, bookId, wren.id, { summary: 'Wren is 14 years old. Wren keeps the lock at Harrow Weir.', baseVersion: 2 });
        await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Ilse', summary: 'Ilse keeps bees.' });
        await forgetExtractions(bookId);
        const before = await getContinuityPage(ctx, bookId);
        expect(before.backfill).toEqual({ total: 2, read: 0, notRead: 0, waiting: 2 });

        // The minutely dispatcher never queues backfill work.
        const minute = recordingEnqueue();
        await executeFactLayerDispatch({ enqueue: minute.enqueue, extractionOpen: () => true, embedder: () => null, workspaceIds: [ctx.workspaceId], now: () => new Date(Date.now() + 60_000) });
        expect(minute.queued).toEqual([]);

        const tick = recordingEnqueue();
        const r = await executeFactBackfill({ ...BACKFILL_DEPS, enqueue: tick.enqueue, workspaceIds: [ctx.workspaceId], cursorName: `test-bf-${unique()}` });
        expect(r).toMatchObject({ workspaces: 1, created: 2, queued: 2 });
        const rows = await runWithoutRls({ reason: 'test' }, (db) => db.bibleFactExtraction.findMany({ where: { bookId }, select: { id: true, origin: true, status: true, bibleVersionId: true, elementId: true } }));
        expect(rows.every((x) => x.origin === 'BACKFILL' && x.status === 'QUEUED')).toBe(true);
        const newestWren = await runWithoutRls({ reason: 'test' }, (db) => db.bibleEntryVersion.findFirstOrThrow({ where: { elementId: wren.id }, orderBy: { versionNumber: 'desc' }, select: { id: true } }));
        expect(rows.find((x) => x.elementId === wren.id)!.bibleVersionId).toBe(newestWren.id);

        // The `bible-facts` job reads them as any extraction, its calls held to the daily share.
        const shares: Array<NightlyShare | undefined> = [];
        for (const q of tick.queued) {
            const out = await executeBibleFactExtraction(q, {
                extractor: (c, share) => (shares.push(share), ageExtractor('Wren')()),
                charge: () => undefined,
                gate: MOUNTED,
                dailyCapMicroUsd: 1_000_000_000,
            });
            expect(out.outcome).toBe('OK');
        }
        expect(shares.every((s) => s?.purpose === 'facts.bible-extract.backfill')).toBe(true);
        const ages = await runInWorkspaceContext(ctx, (db) => db.storyFact.findMany({ where: { bookId, predicate: 'AGE' }, select: { statement: true } }));
        expect(ages.map((a) => a.statement)).toEqual(['Wren is 14 years old.']);
        expect((await getContinuityPage(ctx, bookId)).backfill).toEqual({ total: 2, read: 2, notRead: 0, waiting: 0 });

        // Idempotent: nothing is left to give a row or to queue.
        const again = recordingEnqueue();
        expect(await executeFactBackfill({ ...BACKFILL_DEPS, enqueue: again.enqueue, workspaceIds: [ctx.workspaceId], cursorName: `test-bf-${unique()}` })).toMatchObject({ created: 0, queued: 0 });
    });

    it('is rate-limited a tick, resumable across ticks, and waits at the daily share and the ceiling', async () => {
        const ctx = workspaceCtx(await createAccount());
        const bookId = (await createBook(ctx, { title: 'Many entries' })).id;
        for (let i = 0; i < 5; i++) await createElement(ctx, bookId, { kind: 'CHARACTER', name: `Keeper ${i}`, summary: `Keeper ${i} rows the ferry.` });
        await forgetExtractions(bookId);
        const cursorName = `test-bf-${unique()}`;
        const base = { ...BACKFILL_DEPS, workspaceIds: [ctx.workspaceId], cursorName, entriesPerWorkspace: 2 };

        // The day has no room: nothing is given a row, nothing queued.
        const shut = recordingEnqueue();
        expect(await executeFactBackfill({ ...base, enqueue: shut.enqueue, dailyCapMicroUsd: 0 })).toMatchObject({ deferredAtShare: 1, created: 0, queued: 0 });
        // Two a tick: three ticks read all five, each tick's rows bounded.
        const counts: number[] = [];
        for (let i = 0; i < 3; i++) {
            const t = recordingEnqueue();
            counts.push((await executeFactBackfill({ ...base, enqueue: t.enqueue })).queued);
        }
        expect(counts).toEqual([2, 2, 1]);

        // A backfill extraction past the day's share stops DAILY_SHARE, resumable, no attempt counted.
        const row = await runWithoutRls({ reason: 'test' }, (db) => db.bibleFactExtraction.findFirstOrThrow({ where: { bookId, origin: 'BACKFILL' }, select: { id: true, attempts: true } }));
        const out = await executeBibleFactExtraction({ workspaceId: ctx.workspaceId, extractionId: row.id }, { extractor: ageExtractor('Keeper'), charge: () => undefined, gate: MOUNTED, dailyCapMicroUsd: 0, worstCase: () => 10 });
        expect(out.outcome).toBe('DAILY_SHARE');
        const stopped = await runWithoutRls({ reason: 'test' }, (db) => db.bibleFactExtraction.findUniqueOrThrow({ where: { id: row.id }, select: { status: true, attempts: true, nextAttemptAt: true } }));
        expect(stopped.status).toBe('STOPPED');
        expect(stopped.attempts).toBe(row.attempts - 1);
        expect(stopped.nextAttemptAt).not.toBeNull();
        // Due again later: the backfill (never the minutely dispatcher) queues it once more.
        const minute = recordingEnqueue();
        await executeFactLayerDispatch({ enqueue: minute.enqueue, extractionOpen: () => true, embedder: () => null, workspaceIds: [ctx.workspaceId], callFloorMicroUsd: () => 1, now: () => new Date(Date.now() + 2 * 60 * 60_000) });
        expect(minute.queued).toEqual([]);
        const later = recordingEnqueue();
        await executeFactBackfill({ ...base, enqueue: later.enqueue, now: () => new Date(Date.now() + 2 * 60 * 60_000) });
        expect(later.queued.map((q) => q.extractionId)).toContain(row.id);
    });

    it('skips a workspace whose key will not unwrap and still serves the others (4.H-a\'s servedWorkspace)', async () => {
        const good = workspaceCtx(await createAccount());
        const broken = workspaceCtx(await createAccount());
        const goodBook = (await createBook(good, { title: 'Served' })).id;
        const brokenBook = (await createBook(broken, { title: 'Unreadable' })).id;
        await createElement(good, goodBook, { kind: 'CHARACTER', name: 'Wren', summary: 'Wren keeps the lock.' });
        await createElement(broken, brokenBook, { kind: 'CHARACTER', name: 'Ida', summary: 'Ida rows the ferry.' });
        await forgetExtractions(goodBook);
        await forgetExtractions(brokenBook);
        const row = await runWithoutRls({ reason: 'test' }, (db) => db.workspace.findUniqueOrThrow({ where: { id: broken.workspaceId }, select: { encryptedDek: true } }));
        const wrapped = row.encryptedDek!;
        const at = Math.floor(wrapped.length * 0.6);
        await runWithoutRls({ reason: 'test' }, (db) => db.workspace.update({ where: { id: broken.workspaceId }, data: { encryptedDek: wrapped.slice(0, at) + (wrapped[at] === 'A' ? 'B' : 'A') + wrapped.slice(at + 1) } }));
        workspaceKeys.clear(broken.workspaceId);
        try {
            const t = recordingEnqueue();
            const r = await executeFactBackfill({ ...BACKFILL_DEPS, enqueue: t.enqueue, workspaceIds: [good.workspaceId, broken.workspaceId], cursorName: `test-bf-${unique()}` });
            expect(r.workspacesSkipped).toBe(1);
            expect(t.queued.map((q) => q.workspaceId)).toEqual([good.workspaceId]);
        } finally {
            await runWithoutRls({ reason: 'test' }, (db) => db.workspace.update({ where: { id: broken.workspaceId }, data: { encryptedDek: wrapped } }));
            workspaceKeys.clear(broken.workspaceId);
        }
    });
});

/** `n` bare workspaces (a data key each), each with one book, one element and `versions` versions (the outbox writes their rows). */
async function bareWorkspaces(n: number, versions: number, createdAt: Date): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
        const { workspace } = await runWithoutRls({ reason: 'test' }, (db) => createWorkspaceWithDek(db, { name: `Fair ${i}`, slug: `fair-${unique()}-${i}` }));
        ids.push(workspace.id);
    }
    await runWithoutRls({ reason: 'test' }, async (db) => {
        await db.$executeRaw`INSERT INTO "Book" ("id", "workspaceId", "title", "updatedAt") SELECT 'fb' || w, w, 'Fair', now() FROM unnest(${ids}::text[]) AS w`;
        await db.$executeRaw`INSERT INTO "BibleElement" ("id", "workspaceId", "bookId", "kind", "name", "slug", "updatedAt") SELECT 'fe' || w, w, 'fb' || w, 'CHARACTER', 'Wren', 'wren', now() FROM unnest(${ids}::text[]) AS w`;
        await db.$executeRaw`INSERT INTO "BibleEntryVersion" ("id", "workspaceId", "bookId", "elementId", "versionNumber", "snapshot", "source")
            SELECT 'fv' || w || '-' || v, w, 'fb' || w, 'fe' || w, v, '{}', 'MANUAL' FROM unnest(${ids}::text[]) AS w, generate_series(1, ${versions}) AS v`;
        await db.$executeRaw`UPDATE "BibleFactExtraction" SET "createdAt" = ${createdAt} WHERE "workspaceId" = ANY(${ids}::text[])`;
    });
    return ids;
}

describe('the minutely discovery serves every busy workspace within a bounded number of ticks (#60.4)', () => {
    it('with more than 200 busy workspaces, every one is queued within ⌈busy ÷ 200⌉ ticks, however old the others\' backlogs', async () => {
        // 200 workspaces with old backlogs (five due rows each), and 15 with one new row: 215 busy in all.
        const old = await bareWorkspaces(200, 5, new Date(Date.now() - 86_400_000));
        const fresh = await bareWorkspaces(15, 1, new Date(Date.now() - 60_000));
        const all = [...old, ...fresh];
        const served = new Map<string, number>();
        const cursorName = `test-fair-${unique()}`;
        let ticks = 0;
        while (served.size < all.length && ticks < 10) {
            ticks++;
            const t = recordingEnqueue();
            await executeFactLayerDispatch({ enqueue: t.enqueue, extractionOpen: () => true, embedder: () => null, workspaceIds: all, cursorName, callFloorMicroUsd: () => 1, now: () => new Date(Date.now() + 60_000) });
            for (const q of t.queued) if (!served.has(q.workspaceId)) served.set(q.workspaceId, ticks);
        }
        expect(served.size).toBe(all.length);
        // ⌈215 ÷ 200⌉ = 2: the fifteen new workspaces wait at most one tick behind the old backlogs, never until they drain.
        expect(ticks).toBeLessThanOrEqual(Math.ceil(all.length / 200));
        expect(Math.max(...fresh.map((w) => served.get(w)!))).toBeLessThanOrEqual(2);
    });
});

describe('an autosave of a heavily cited element rewrites no standing flag (#62.2)', () => {
    it('a second save leaves every OPEN, standing flag untouched (counted rows); a dismissed one is raised again; the page still shows the newest change', async () => {
        const ctx = workspaceCtx(await createAccount());
        const bookId = (await createBook(ctx, { title: 'Cited' })).id;
        const upstream = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Marrow', summary: 'Marrow keeps the mill.' });
        const answer = await answerAbout(ctx, bookId, upstream.id, 'Marrow burned the mill.');
        const citing: string[] = [];
        for (let i = 0; i < 30; i++) {
            const d = await createElement(ctx, bookId, { kind: 'CHARACTER', name: `Witness ${i}` });
            await citeAnswers(ctx, bookId, d.id, [answer]);
            citing.push(d.id);
        }
        const flagTuples = () => runWithoutRls({ reason: 'test' }, (db) => db.$queryRaw<Array<{ id: string; xmin: string; status: string }>>`SELECT "id", xmin::text AS xmin, "status" FROM "StaleFlag" WHERE "upstreamElementId" = ${upstream.id} ORDER BY "id"`);
        await updateElement(ctx, bookId, upstream.id, { summary: 'Marrow is innocent.', baseVersion: 1 });
        const raised = await flagTuples();
        expect(raised).toHaveLength(30);

        // The autosaves that follow: no flag row is written again (its tuple, xmin, is the same one).
        await updateElement(ctx, bookId, upstream.id, { summary: 'Marrow is innocent after all.', baseVersion: 2 });
        await updateElement(ctx, bookId, upstream.id, { summary: 'Marrow is innocent after all, the court says.', baseVersion: 3 });
        const after = await flagTuples();
        expect(after.filter((f, i) => f.xmin !== raised[i].xmin)).toEqual([]);
        // The page still shows the change running to the newest version.
        const page = await getContinuityPage(ctx, bookId);
        expect(page.stale.items.filter((f) => f.upstreamElementId === upstream.id).every((f) => f.fromVersion === 1 && f.toVersion === 4)).toBe(true);

        // A dismissed flag is raised again by the next change (its state changes: that row, and only it, is written).
        const one = page.stale.items[0];
        await runInWorkspaceContext(ctx, (db) => db.staleFlag.updateMany({ where: { id: one.id }, data: { status: 'DISMISSED', dismissedAt: new Date(), dismissedById: ctx.userId } }));
        const dismissed = await flagTuples();
        await updateElement(ctx, bookId, upstream.id, { summary: 'Marrow left the town.', baseVersion: 4 });
        const reraised = await flagTuples();
        expect(reraised.filter((f, i) => f.xmin !== dismissed[i].xmin).map((f) => [f.id, f.status])).toEqual([[one.id, 'OPEN']]);
    });
});

describe('the book purge shares a run between workspaces (the 4.H-a review)', () => {
    it('one workspace holding a run\'s worth of due books never starves another\'s', async () => {
        const heavy = workspaceCtx(await createAccount());
        const light = workspaceCtx(await createAccount());
        // Older than any other suite's deleted book, so these two workspaces are the first a run reads.
        const longAgo = new Date(Date.now() - 4_000 * 86_400_000);
        const heavyBooks: string[] = [];
        for (let i = 0; i < 6; i++) {
            const id = (await createBook(heavy, { title: `Old ${i}` })).id;
            await deleteBook(heavy, id);
            heavyBooks.push(id);
        }
        const lightBook = (await createBook(light, { title: 'Newer' })).id;
        await deleteBook(light, lightBook);
        await runWithoutRls({ reason: 'test' }, async (db) => {
            await db.book.updateMany({ where: { id: { in: heavyBooks } }, data: { deletedAt: longAgo } });
            await db.book.updateMany({ where: { id: lightBook }, data: { deletedAt: new Date(longAgo.getTime() + 86_400_000) } });
        });
        // A run of three: the heavy workspace's six oldest books would fill it; the light one gets its share.
        const due = await runWithoutRls({ reason: 'test' }, (db) => BookRepository.listPurgeDue(db, restoreCutoff(new Date()), 3));
        expect(due.some((b) => b.id === lightBook)).toBe(true);
        expect(due.filter((b) => b.workspaceId === heavy.workspaceId)).toHaveLength(2);
        const r = await purgeDeletedBooks({ batch: 50 });
        expect(r.failed).toBe(0);
        expect(await runWithoutRls({ reason: 'test' }, (db) => db.book.count({ where: { id: { in: [...heavyBooks, lightBook] } } }))).toBe(0);
    });
});
